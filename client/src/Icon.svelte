<script lang="ts" module>
  const PATHS = {
    back: 'm15 18-6-6 6-6',
    chevron: 'm9 18 6-6-6-6',
    chevronDown: 'm6 9 6 6 6-6',
    clock: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
    close: 'M18 6 6 18M6 6l12 12',
    down: 'M12 5v14m-7-7 7 7 7-7',
    expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
    external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    play: 'M7 4.5v15l12.5-7.5z',
    plus: 'M12 5v14M5 12h14',
    redo: 'M21 7v6h-6M3 17a9 9 0 0 1 15-6.7l3 2.7',
    restart: 'M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5',
    stop: 'M6.5 6.5h11v11h-11z',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm10 3-5-5',
    settings: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
    shrink: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
    undo: 'M3 7v6h6M21 17a9 9 0 0 0-15-6.7L3 13',
  };
  export type IconName = keyof typeof PATHS;
</script>

<script lang="ts">
  let { name, size = 20 }: { name: IconName; size?: number } = $props();
</script>

<svg viewBox="0 0 24 24" width={size} height={size} stroke-width={name === 'more' ? 3.5 : 2} aria-hidden="true">
  <path d={PATHS[name]} />
</svg>

<style>
  svg {
    flex: none;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
