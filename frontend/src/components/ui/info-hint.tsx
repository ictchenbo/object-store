import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Info } from "lucide-react";

type InfoHintProps = {
  content: React.ReactNode;
  label?: string;
};

const InfoHintContext = React.createContext<{
  openId: string | null;
  setOpenId: React.Dispatch<React.SetStateAction<string | null>>;
} | null>(null);

export function InfoHintProvider({ children }: { children: React.ReactNode }) {
  const [openId, setOpenId] = React.useState<string | null>(null);

  return (
    <TooltipPrimitive.Provider delayDuration={200}>
      <InfoHintContext.Provider value={{ openId, setOpenId }}>{children}</InfoHintContext.Provider>
    </TooltipPrimitive.Provider>
  );
}

/** 标题旁的补充说明：悬停、键盘聚焦或点击时显示。 */
export function InfoHint({ content, label = "查看说明" }: InfoHintProps) {
  const id = React.useId();
  const context = React.useContext(InfoHintContext);
  const open = context?.openId === id;
  const setOpen = (nextOpen: boolean) =>
    context?.setOpenId((current) => nextOpen ? id : current === id ? null : current);

  return (
    <TooltipPrimitive.Root open={open} onOpenChange={setOpen}>
      <TooltipPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setOpen(!open)}
        >
          <Info className="size-4" aria-hidden="true" />
        </button>
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side="bottom"
          sideOffset={6}
          className="z-50 max-w-[min(20rem,calc(100vw-2rem))] rounded-md border bg-popover px-3 py-2 text-sm font-normal leading-relaxed text-popover-foreground shadow-md"
        >
          {content}
          <TooltipPrimitive.Arrow className="fill-popover" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
