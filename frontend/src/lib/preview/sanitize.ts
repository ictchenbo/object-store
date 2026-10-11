/**
 * DOCX → HTML 的消毒层。这是 mammoth 解析器与活 DOM 之间的**唯一**屏障。
 *
 * 中文注释：mammoth README 明确声明「不做任何源文档消毒」，而它跑在
 * 攻击者可控的 OOXML 上、历史上出过 bug。所以 DOMPurify 不是可选加固，
 * 是安全边界本身。
 *
 * 刻意**不使用**的特性（历史绕过漏洞集中区）：
 *   - IN_PLACE: true            —— GHSA-55q2-fjhq-7xh7 / GHSA-rp9w-3fw7-7cwq / GHSA-r47g-fvhr-h676
 *   - ADD_TAGS / ADD_ATTR 函数形式 —— GHSA-39q2-94rc-95cp / GHSA-cjmm-f4jc-qw8r
 *   - USE_PROFILES              —— GHSA-cj63-jhhr-wcxv（原型污染 → 放行事件处理器）
 *   - CUSTOM_ELEMENT_HANDLING   —— GHSA-v9jr-rg53-9pgp（原型污染 → XSS）
 *   - SAFE_FOR_TEMPLATES        —— GHSA-gvmj-g25r-r7wr
 */

import DOMPurify from "dompurify";

/**
 * 消毒并返回可挂载的 DocumentFragment。
 *
 * 中文注释：配置内联展开，让 TS 从 `RETURN_DOM_FRAGMENT: true` 窄化出
 * DocumentFragment —— 这是全文件唯一一处类型断言。
 *
 * 要点：
 *   - ALLOWED_TAGS / ALLOWED_ATTR 是主边界（白名单）；FORBID_* 是后备黑名单。
 *   - FORBID_CONTENTS **必写**：否则默认 KEEP_CONTENT:true 会把
 *     `<script>alert(1)</script>` 变成可见文本 `alert(1)`。
 *   - 禁 id / name —— 防 DOM clobbering。
 *   - 禁 style —— CSS 注入可数据外带（background:url）与界面伪装；用户已接受丢排版。
 *   - 禁 target —— 防反向 tabnabbing。
 *   - href：DOMPurify 默认拦 javascript: / vbscript: / data:text/html；
 *     data: 仅在 img src 上放行（正是 mammoth 内嵌图需要的）。
 */
export function sanitizeDocxHtml(html: string): DocumentFragment {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "p", "br", "h1", "h2", "h3", "h4", "h5", "h6",
      "strong", "b", "em", "i", "u", "s", "strike", "sup", "sub",
      "ul", "ol", "li", "blockquote", "pre", "code", "hr",
      "table", "thead", "tbody", "tfoot", "tr", "th", "td",
      "a", "img", "span",
    ],
    ALLOWED_ATTR: ["href", "src", "alt", "title", "class", "colspan", "rowspan"],
    FORBID_TAGS: [
      "script", "style", "iframe", "object", "embed", "form", "input", "button",
      "select", "textarea", "link", "meta", "base", "svg", "math", "template",
      "noscript", "video", "audio", "frame", "frameset",
    ],
    FORBID_ATTR: [
      "style", "id", "name", "target", "download", "ping", "srcset", "formaction",
      "autofocus", "xlink:href", "xmlns",
      "onerror", "onclick", "onload", "onmouseover", "onfocus", "onblur",
      "onmouseenter", "onmouseleave", "onanimationstart", "onfocusin", "onfocusout", "ontoggle",
    ],
    FORBID_CONTENTS: [
      "script", "style", "noscript", "template", "title", "textarea",
      "xmp", "plaintext", "iframe", "object", "embed",
    ],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    SANITIZE_DOM: true,
    SAFE_FOR_TEMPLATES: false,
    IN_PLACE: false,
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: true,
    WHOLE_DOCUMENT: false,
    // 刻意不写：ADD_TAGS / ADD_ATTR / USE_PROFILES / CUSTOM_ELEMENT_HANDLING / ALLOWED_URI_REGEXP
  });
}
