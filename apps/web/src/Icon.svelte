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
    FolderPlus,
    GripVertical,
    Menu,
    PencilLine,
    Search,
    ShieldCheck,
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
    | "folder-plus"
    | "grip"
    | "menu"
    | "rename"
    | "search"
    | "send"
    | "shield"
    | "stop"
    | "tool"
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
    "folder-plus": FolderPlus,
    grip: GripVertical,
    menu: Menu,
    rename: PencilLine,
    search: Search,
    send: ArrowUp,
    shield: ShieldCheck,
    stop: Square,
    tool: Wrench,
    x: X,
  };

  let { name, size = 16 }: { name: IconName; size?: number } = $props();
  let IconComponent = $derived(icons[name]);
</script>

<IconComponent {size} strokeWidth={1.8} aria-hidden="true" />
