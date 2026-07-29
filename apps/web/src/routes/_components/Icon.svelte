<script lang="ts">
  import {
    Activity,
    ArrowDown,
    ArrowUp,
    Check,
    ChevronRight,
    ChevronsDownUp,
    Copy,
    Folder,
    FolderGit2,
    FolderOpen,
    FolderPlus,
    GripVertical,
    Menu,
    PanelLeftClose,
    PanelLeftOpen,
    PencilLine,
    Search,
    ShieldCheck,
    Split,
    Square,
    SquarePen,
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
    | "folder"
    | "folder-git"
    | "folder-open"
    | "folder-plus"
    | "grip"
    | "menu"
    | "rename"
    | "search"
    | "send"
    | "shield"
    | "sidebar-collapse"
    | "sidebar-expand"
    | "stop"
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
    folder: Folder,
    "folder-git": FolderGit2,
    "folder-open": FolderOpen,
    "folder-plus": FolderPlus,
    grip: GripVertical,
    menu: Menu,
    rename: PencilLine,
    search: Search,
    send: ArrowUp,
    shield: ShieldCheck,
    "sidebar-collapse": PanelLeftClose,
    "sidebar-expand": PanelLeftOpen,
    stop: Square,
    tool: Wrench,
    worktree: Split,
    x: X,
  };

  let { name, size = 16 }: { name: IconName; size?: number } = $props();
  let IconComponent = $derived(icons[name]);
</script>

<IconComponent {size} strokeWidth={1.8} aria-hidden="true" />
