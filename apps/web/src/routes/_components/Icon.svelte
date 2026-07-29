<script lang="ts">
  import {
    Activity,
    ArrowDown,
    ArrowUp,
    Check,
    ChevronRight,
    ChevronsDownUp,
    Copy,
    FileText,
    Folder,
    FolderGit2,
    FolderOpen,
    FolderPlus,
    GripVertical,
    LoaderCircle,
    Menu,
    PanelLeftClose,
    PanelLeftOpen,
    PencilLine,
    Search,
    ShieldCheck,
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
    | "arrow-down"
    | "check"
    | "chevron"
    | "compact"
    | "compose"
    | "copy"
    | "file"
    | "folder"
    | "folder-git"
    | "folder-open"
    | "folder-plus"
    | "grip"
    | "loader"
    | "menu"
    | "rename"
    | "search"
    | "send"
    | "shield"
    | "sidebar-collapse"
    | "sidebar-expand"
    | "stop"
    | "terminal"
    | "tool"
    | "worktree"
    | "x";

  const icons: Record<IconName, LucideIcon> = {
    activity: Activity,
    "arrow-down": ArrowDown,
    check: Check,
    chevron: ChevronRight,
    compact: ChevronsDownUp,
    compose: SquarePen,
    copy: Copy,
    file: FileText,
    folder: Folder,
    "folder-git": FolderGit2,
    "folder-open": FolderOpen,
    "folder-plus": FolderPlus,
    grip: GripVertical,
    loader: LoaderCircle,
    menu: Menu,
    rename: PencilLine,
    search: Search,
    send: ArrowUp,
    shield: ShieldCheck,
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
