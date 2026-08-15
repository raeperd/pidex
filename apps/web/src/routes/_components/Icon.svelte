<script lang="ts">
  import {
    Activity,
    ArrowDown,
    ArrowUp,
    Check,
    ChevronRight,
    CircleAlert,
    Copy,
    FileText,
    Folder,
    FolderGit2,
    FolderOpen,
    FolderPlus,
    LoaderCircle,
    Menu,
    PanelLeftClose,
    PanelLeftOpen,
    PencilLine,
    Search,
    Split,
    Square,
    SquarePen,
    Terminal,
    Wrench,
    X,
    type LucideIcon,
  } from "@lucide/svelte";

  type IconName =
    | "activity"
    | "alert"
    | "arrow-down"
    | "check"
    | "chevron"
    | "compose"
    | "copy"
    | "file"
    | "folder"
    | "folder-git"
    | "folder-open"
    | "folder-plus"
    | "loader"
    | "menu"
    | "rename"
    | "search"
    | "send"
    | "sidebar-collapse"
    | "sidebar-expand"
    | "stop"
    | "terminal"
    | "tool"
    | "worktree"
    | "x";

  const icons: Record<IconName, LucideIcon> = {
    activity: Activity,
    alert: CircleAlert,
    "arrow-down": ArrowDown,
    check: Check,
    chevron: ChevronRight,
    compose: SquarePen,
    copy: Copy,
    file: FileText,
    folder: Folder,
    "folder-git": FolderGit2,
    "folder-open": FolderOpen,
    "folder-plus": FolderPlus,
    loader: LoaderCircle,
    menu: Menu,
    rename: PencilLine,
    search: Search,
    send: ArrowUp,
    "sidebar-collapse": PanelLeftClose,
    "sidebar-expand": PanelLeftOpen,
    stop: Square,
    terminal: Terminal,
    tool: Wrench,
    worktree: Split,
    x: X,
  };

  let { name, size = 16 }: { name: IconName; size?: number } = $props();
  let IconComponent = $derived(icons[name]);
</script>

<IconComponent {size} strokeWidth={1.8} aria-hidden="true" />
