import * as React from "react";
import { Moon, Sun, SunMoon } from "lucide-react";
import { loadTheme, saveTheme } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type ThemeMode = "light" | "dark" | "system";
const THEME_CHANGED_EVENT = "object-store:theme-changed";

function applyThemeClass(next: ThemeMode) {
  const root = document.documentElement;
  if (next === "system") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.classList.toggle("dark", prefersDark);
  } else {
    root.classList.toggle("dark", next === "dark");
  }
}

/** 主题切换：浅色 / 深色 / 跟随系统。受控状态，切换后图标立即更新。 */
export function ThemeToggle() {
  const [theme, setTheme] = React.useState<ThemeMode>(() => loadTheme());

  React.useEffect(() => {
    // 中文注释：桌面侧栏和移动抽屉各有按钮，切换后同步两处显示。
    const syncTheme = () => setTheme(loadTheme());
    window.addEventListener(THEME_CHANGED_EVENT, syncTheme);
    return () => window.removeEventListener(THEME_CHANGED_EVENT, syncTheme);
  }, []);

  function apply(next: ThemeMode) {
    saveTheme(next);
    applyThemeClass(next);
    setTheme(next);
    window.dispatchEvent(new Event(THEME_CHANGED_EVENT));
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="w-full justify-between" aria-label="切换主题">
          <span className="flex items-center gap-2">
            {theme === "dark" ? <Moon className="size-4" /> : theme === "light" ? <Sun className="size-4" /> : <SunMoon className="size-4" />}
            外观
          </span>
          <span className="text-xs text-muted-foreground">
            {theme === "dark" ? "深色" : theme === "light" ? "浅色" : "跟随系统"}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onClick={() => apply("light")}>
          <Sun className="size-4" /> 浅色
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => apply("dark")}>
          <Moon className="size-4" /> 深色
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => apply("system")}>
          <SunMoon className="size-4" /> 跟随系统
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 根据保存的主题初始化 <html> class */
export function initTheme() {
  applyThemeClass(loadTheme());
  // 中文注释：跟随系统时，系统外观变化无需刷新页面即可生效。
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (loadTheme() === "system") applyThemeClass("system");
  });
}
