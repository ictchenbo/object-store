import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileUp,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import { api, putToPresignedUrl } from "@/lib/api";
import type { AssetDraft, IngestCreated, ObjectItem, TagItem } from "@/lib/types";
import { formatBytes, parseJsonObject } from "@/lib/format";
import { useAuth } from "@/hooks/use-auth";
import { ErrorAlert } from "@/components/common/ErrorAlert";
import { JsonField } from "@/components/common/JsonField";
import { TagPicker, splitTags } from "@/components/tags/TagPicker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { InfoHint } from "@/components/ui/info-hint";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/use-toast";

type AssetRole = "cover" | "inline_image" | "attachment";

interface UploadedObject {
  object_id: string;
  display_name: string;
  size_bytes: number | null;
}

const STEPS = ["文档信息", "上传对象", "发布版本"] as const;

/** 上传单个 document_internal 对象：会话 → 直传 → 完成 */
async function uploadInternalObject(file: File, purpose: "document_internal" = "document_internal"): Promise<ObjectItem> {
  const created = await api.createUpload({
    display_name: file.name,
    content_type: file.type || "application/octet-stream",
    expected_size: file.size,
    purpose,
  });
  if (created.upload_url && created.upload_id) {
    await putToPresignedUrl(created.upload_url, file);
    return api.completeUpload(created.upload_id);
  }
  return api.getObject(created.object_id);
}

/**
 * 文档入库向导：
 * 1) POST /ingest-sessions 建暂存版本
 * 2) 为原文/正文/附件分别走对象层上传（purpose=document_internal）
 * 3) POST /ingest-sessions/{id}/complete 校验并发布版本
 */
export function IngestPage() {
  const navigate = useNavigate();
  const { canWrite } = useAuth();
  const [step, setStep] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);

  // 第 1 步：文档信息
  const [source, setSource] = React.useState("");
  const [externalId, setExternalId] = React.useState("");
  const [docType, setDocType] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [ingestKey, setIngestKey] = React.useState("");
  const [docAttrsText, setDocAttrsText] = React.useState("");
  const [tags, setTags] = React.useState<TagItem[]>([]);

  // 第 2 步：对象上传
  const [rawFile, setRawFile] = React.useState<File | null>(null);
  const [bodyFile, setBodyFile] = React.useState<File | null>(null);
  const [rawObject, setRawObject] = React.useState<UploadedObject | null>(null);
  const [bodyObject, setBodyObject] = React.useState<UploadedObject | null>(null);
  const [assetRows, setAssetRows] = React.useState<
    Array<{ file: File | null; role: AssetRole; ordinal: number; referenceName: string; uploaded: UploadedObject | null }>
  >([]);

  // 第 3 步：版本属性
  const [versionAttrsText, setVersionAttrsText] = React.useState("");

  const [ingest, setIngest] = React.useState<IngestCreated | null>(null);
  const [types, setTypes] = React.useState<Array<{ code: string; display_name: string }>>([]);
  const [createdDocumentId, setCreatedDocumentId] = React.useState<string | null>(null);

  React.useEffect(() => {
    api
      .listDocumentTypes()
      .then((result) => setTypes(result.items))
      .catch(() => setTypes([]));
  }, []);

  function toUploaded(item: ObjectItem): UploadedObject {
    return { object_id: item.id, display_name: item.display_name, size_bytes: item.size_bytes };
  }

  async function handleCreateIngest() {
    setError(null);
    if (!source.trim() || !externalId.trim() || !docType || !title.trim() || !ingestKey.trim()) {
      setError(new Error("来源、外部 ID、类型、标题与 ingest_key 均为必填"));
      return;
    }
    const parsed = parseJsonObject(docAttrsText);
    if (parsed.error) {
      setError(new Error(`文档属性：${parsed.error}`));
      return;
    }
    setBusy(true);
    try {
      const result = await api.createIngest({
        source: source.trim(),
        external_id: externalId.trim(),
        doc_type: docType,
        title: title.trim(),
        ingest_key: ingestKey.trim(),
        attrs: parsed.value,
        ...splitTags(tags),
      });
      setIngest(result);
      toast({
        title: result.status === "staging" ? "采集会话已创建" : "采集会话已存在（幂等）",
        description: `文档 ${result.document_id} · 版本 v${result.version_no}`,
        tone: "success",
      });
      setStep(1);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function uploadOne(file: File): Promise<UploadedObject> {
    const item = await uploadInternalObject(file);
    return toUploaded(item);
  }

  async function handleUploadObjects() {
    setError(null);
    // 中文注释：校验必须同时考虑「待上传文件」与「已就绪对象」，否则首次点击永远无法通过
    const hasPendingOrUploaded =
      Boolean(rawFile || rawObject) ||
      Boolean(bodyFile || bodyObject) ||
      assetRows.some((row) => row.file || row.uploaded);
    if (!hasPendingOrUploaded) {
      setError(new Error("至少上传原文、正文或一个附件对象"));
      return;
    }
    setBusy(true);
    try {
      if (rawFile && !rawObject) setRawObject(await uploadOne(rawFile));
      if (bodyFile && !bodyObject) setBodyObject(await uploadOne(bodyFile));
      const nextRows = [...assetRows];
      for (let index = 0; index < nextRows.length; index += 1) {
        const row = nextRows[index];
        if (row.file && !row.uploaded) {
          nextRows[index] = { ...row, uploaded: await uploadOne(row.file) };
        }
      }
      setAssetRows(nextRows);
      const uploadedCount =
        (rawFile || rawObject ? 1 : 0) + (bodyFile || bodyObject ? 1 : 0) + nextRows.filter((row) => row.uploaded).length;
      toast({ title: "对象上传完成", description: `共 ${uploadedCount} 个对象就绪`, tone: "success" });
      setStep(2);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function handlePublish() {
    if (!ingest) return;
    setError(null);
    const parsed = parseJsonObject(versionAttrsText);
    if (parsed.error) {
      setError(new Error(`版本属性：${parsed.error}`));
      return;
    }
    const assets: AssetDraft[] = assetRows
      .filter((row) => row.uploaded)
      .map((row) => ({
        object_id: row.uploaded!.object_id,
        role: row.role,
        ordinal: row.ordinal,
        reference_name: row.referenceName.trim(),
      }));
    // 角色+顺序去重校验（与服务端一致）
    const keys = new Set(assets.map((item) => `${item.role}:${item.ordinal}`));
    if (keys.size !== assets.length) {
      setError(new Error("附件角色与顺序不能重复"));
      return;
    }
    setBusy(true);
    try {
      const document = await api.completeIngest(ingest.ingest_session_id, {
        raw_object_id: rawObject?.object_id,
        body_object_id: bodyObject?.object_id,
        assets,
        attrs: parsed.value,
      });
      setCreatedDocumentId(document.id);
      toast({ title: "版本已发布", description: document.title, tone: "success" });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  function addAssetRow() {
    setAssetRows((rows) => [
      ...rows,
      { file: null, role: "inline_image", ordinal: rows.length, referenceName: "", uploaded: null },
    ]);
  }

  // 中文注释：viewer 只读，直接访问入库页时拦截
  if (!canWrite) {
    return (
      <div className="space-y-5">
        <h2 className="text-2xl font-semibold tracking-tight">文档入库</h2>
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            只读角色（viewer）不能执行文档入库，请联系管理员。
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          文档入库
          <InfoHint content="为原文、正文与附件分别创建上传会话，全部就绪后再发布版本；服务端负责将文件放入正式存储位置。" label="查看文档入库流程说明" />
        </h2>
      </div>

      {/* 步骤条 */}
      <div className="flex flex-wrap items-center gap-2">
        {STEPS.map((label, index) => (
          <div
            key={label}
            className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${
              index === step
                ? "border-primary bg-primary/10 text-primary"
                : index < step
                  ? "border-success/40 bg-success/10 text-success"
                  : "text-muted-foreground"
            }`}
          >
            {index < step ? <CheckCircle2 className="size-3.5" /> : <span className="tabular-nums">{index + 1}</span>}
            {label}
          </div>
        ))}
      </div>

      {createdDocumentId ? (
        <Card className="border-success/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-success">
              <CheckCircle2 className="size-5" />
              版本发布成功
            </CardTitle>
            <CardDescription>可前往文档详情查看当前版本、历史与附件关系。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button onClick={() => navigate(`/documents/${createdDocumentId}`)}>查看文档</Button>
            <Button
              variant="outline"
              onClick={() => {
                setCreatedDocumentId(null);
                setStep(0);
                setIngest(null);
                setRawFile(null);
                setBodyFile(null);
                setRawObject(null);
                setBodyObject(null);
                setAssetRows([]);
              }}
            >
              再入库一篇
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <ErrorAlert error={error} />

          {/* 第 1 步 */}
          {step === 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  1 · 文档信息
                  <InfoHint content="以来源和外部 ID 定位或创建文档；同一采集键重复提交会返回原会话。" label="查看文档信息说明" />
                </CardTitle>
                <CardDescription className="text-amber-700 dark:text-amber-400">
                  已有文档的类型如需变更，请使用重分类功能；入库时类型不匹配会被拒绝。
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="来源-source-">来源 source *</Label>
                    <Input id="来源-source-" value={source} placeholder="crawler" onChange={(e) => setSource(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="外部-ID-externalid-">外部 ID external_id *</Label>
                    <Input id="外部-ID-externalid-" value={externalId} placeholder="doc-001" onChange={(e) => setExternalId(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="文档类型-doctype-">文档类型 doc_type *</Label>
                    <Select value={docType} onValueChange={setDocType}>
                      <SelectTrigger id="文档类型-doctype-">
                        <SelectValue placeholder="选择类型" />
                      </SelectTrigger>
                      <SelectContent>
                        {types.map((item) => (
                          <SelectItem key={item.code} value={item.code}>
                            {item.display_name}（{item.code}）
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="标题-title-">标题 title *</Label>
                    <Input id="标题-title-" value={title} onChange={(e) => setTitle(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="采集键-ingestkey-">采集键 ingest_key *</Label>
                    <Input id="采集键-ingestkey-"
                      value={ingestKey}
                      placeholder="revision-1"
                      onChange={(e) => setIngestKey(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">同一文档下唯一；重试同键幂等，新修订换新键</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="文档标签可选">文档标签（可选）</Label>
                    <TagPicker inputId="文档标签可选" value={tags} onChange={setTags} />
                  </div>
                </div>
                <JsonField label="文档属性 attrs（逻辑文档级）" value={docAttrsText} onChange={setDocAttrsText} />
                <div className="flex justify-end">
                  <Button data-testid="ingest-step1-next" onClick={handleCreateIngest} disabled={busy}>
                    {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                    下一步：上传对象
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}

          {/* 第 2 步 */}
          {step === 1 ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  2 · 上传对象
                  <InfoHint content="原文、正文和附件上传后由服务端转为就绪状态；已上传文件可保留，之后继续补齐。" label="查看上传对象说明" />
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="原文-raw如-PDFHTML-文件">原文 raw（如 PDF/HTML 文件）</Label>
                    <Input id="原文-raw如-PDFHTML-文件"
                      type="file"
                      data-testid="ingest-raw-file"
                      disabled={busy || Boolean(rawObject)}
                      onChange={(e) => setRawFile(e.target.files?.[0] || null)}
                    />
                    {rawObject ? (
                      <p className="text-xs text-success">
                        已就绪 · {rawObject.display_name} · {formatBytes(rawObject.size_bytes)}
                      </p>
                    ) : rawFile ? (
                      <p className="text-xs text-muted-foreground">待上传：{rawFile.name}</p>
                    ) : null}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="正文-body纯文本结构化正文">正文 body（纯文本/结构化正文）</Label>
                    <Input id="正文-body纯文本结构化正文"
                      type="file"
                      data-testid="ingest-body-file"
                      disabled={busy || Boolean(bodyObject)}
                      onChange={(e) => setBodyFile(e.target.files?.[0] || null)}
                    />
                    {bodyObject ? (
                      <p className="text-xs text-success">
                        已就绪 · {bodyObject.display_name} · {formatBytes(bodyObject.size_bytes)}
                      </p>
                    ) : bodyFile ? (
                      <p className="text-xs text-muted-foreground">待上传：{bodyFile.name}</p>
                    ) : null}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label id="图片与附件-label">图片与附件</Label>
                    <Button type="button" variant="outline" size="sm" onClick={addAssetRow} disabled={busy}>
                      <Plus className="size-4" />
                      添加附件
                    </Button>
                  </div>
                  {assetRows.length === 0 ? (
                    <p className="text-xs text-muted-foreground">没有附件行；纯文本版本可跳过。</p>
                  ) : (
                    <div className="space-y-3" role="group" aria-labelledby="图片与附件-label">
                      {assetRows.map((row, index) => (
                        <div key={index} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-12">
                          <div className="sm:col-span-4">
                            <Label className="text-xs" htmlFor="文件">文件</Label>
                            <Input id="文件"
                              type="file"
                              data-testid={`ingest-asset-file-${index}`}
                              disabled={busy || Boolean(row.uploaded)}
                              onChange={(event) => {
                                const file = event.target.files?.[0] || null;
                                setAssetRows((rows) =>
                                  rows.map((item, i) => (i === index ? { ...item, file } : item)),
                                );
                              }}
                            />
                            {row.uploaded ? (
                              <p className="mt-1 text-xs text-success">
                                已就绪 · {row.uploaded.display_name}
                              </p>
                            ) : null}
                          </div>
                          <div className="sm:col-span-3">
                            <Label className="text-xs" htmlFor="角色">角色</Label>
                            <Select
                              value={row.role}
                              disabled={busy}
                              onValueChange={(value: AssetRole) =>
                                setAssetRows((rows) =>
                                  rows.map((item, i) => (i === index ? { ...item, role: value } : item)),
                                )
                              }
                            >
                              <SelectTrigger id="角色">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="cover">封面 cover</SelectItem>
                                <SelectItem value="inline_image">内嵌图片 inline_image</SelectItem>
                                <SelectItem value="attachment">附件 attachment</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="sm:col-span-2">
                            <Label className="text-xs" htmlFor="顺序-ordinal">顺序 ordinal</Label>
                            <Input id="顺序-ordinal"
                              type="number"
                              min={0}
                              value={row.ordinal}
                              disabled={busy}
                              onChange={(event) =>
                                setAssetRows((rows) =>
                                  rows.map((item, i) =>
                                    i === index ? { ...item, ordinal: Number(event.target.value) || 0 } : item,
                                  ),
                                )
                              }
                            />
                          </div>
                          <div className="sm:col-span-2">
                            <Label className="text-xs" htmlFor="引用名">引用名</Label>
                            <Input id="引用名"
                              value={row.referenceName}
                              disabled={busy}
                              placeholder="fig-1.png"
                              onChange={(event) =>
                                setAssetRows((rows) =>
                                  rows.map((item, i) =>
                                    i === index ? { ...item, referenceName: event.target.value } : item,
                                  ),
                                )
                              }
                            />
                          </div>
                          <div className="flex items-end sm:col-span-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              disabled={busy}
                              onClick={() =>
                                setAssetRows((rows) =>
                                  // 中文注释：删行后按索引重排 ordinal，避免出现空洞导致同角色排序错乱
                                  rows.filter((_, i) => i !== index).map((item, i) => ({ ...item, ordinal: i })),
                                )
                              }
                            >
                              <Trash2 className="size-4 text-destructive" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex justify-between">
                  <Button variant="outline" onClick={() => setStep(0)} disabled={busy}>
                    <ChevronLeft className="size-4" />
                    上一步
                  </Button>
                  <Button data-testid="ingest-upload-next" onClick={handleUploadObjects} disabled={busy}>
                    {busy ? <Loader2 className="size-4 animate-spin" /> : <FileUp className="size-4" />}
                    上传并继续
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}

          {/* 第 3 步 */}
          {step === 2 ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  3 · 发布版本
                  <InfoHint content="服务端校验所需文件均已就绪，再写入版本属性和附件关系，并将其设为当前版本。" label="查看发布版本说明" />
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2 rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap gap-2">
                    {ingest ? (
                      <Badge variant="brand">
                        文档 {ingest.document_id.slice(0, 8)}… · v{ingest.version_no}
                      </Badge>
                    ) : null}
                    {rawObject ? <Badge variant="secondary">原文就绪</Badge> : null}
                    {bodyObject ? <Badge variant="secondary">正文就绪</Badge> : null}
                    <Badge variant="secondary">
                      附件 {assetRows.filter((row) => row.uploaded).length} 个
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    至少需要原文、正文或一个附件对象；standalone 对象不能作为文档对象引用。
                  </p>
                </div>
                <JsonField label="版本属性 attrs（类型专有属性，随版本快照）" value={versionAttrsText} onChange={setVersionAttrsText} />
                <div className="flex justify-between">
                  <Button variant="outline" onClick={() => setStep(1)} disabled={busy}>
                    <ChevronLeft className="size-4" />
                    上一步
                  </Button>
                  <Button data-testid="ingest-publish" onClick={handlePublish} disabled={busy}>
                    {busy ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                    发布版本
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}

          <p className="text-xs text-muted-foreground">
            提示：重复提交相同 (source, external_id, ingest_key) 会返回原采集会话；新的有效修订请更换 ingest_key。
            详见 <Link to="/documents" className="text-primary underline-offset-4 hover:underline">文档列表</Link>。
          </p>
        </>
      )}
    </div>
  );
}
