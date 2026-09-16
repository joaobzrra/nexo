// Nexo theme registry.
// A theme is a pure identity swap: CSS tokens live in style.css under
// body[data-theme="<id>"]; this file carries what CSS cannot reach — the
// xterm palette (terminal text, ANSI colors, cursor) and per-provider cursor
// variants. Structure is theme-stable by ruling: no theme may change pane
// geometry, and provider color never tints the terminal wall.
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.NEXO_THEMES = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // Terminal background stays fully transparent in every theme: the pane's
  // themed well (CSS) shows through, so the wall color is CSS's business.
  const CLEAR = "#00000000";

  const themes = {
    glass: {
      label: "Nexo Glass",
      swatch: { bg: "#10141b", accent: "#53c7cf" },
      xterm: {
        background: CLEAR,
        foreground: "#dce4ed",
        cursor: "#53c7cf",
        cursorAccent: "#0c1013",
        selectionBackground: "#1e3a3d",
        black: "#111720", red: "#d56655", green: "#5aa98b", yellow: "#d0a45d",
        blue: "#6f9edf", magenta: "#b58ac9", cyan: "#58b9a6", white: "#c7d0dc",
        brightBlack: "#5c6879", brightRed: "#e07a5f", brightGreen: "#7cc4a5",
        brightYellow: "#dfb878", brightBlue: "#93b8ec", brightMagenta: "#cfa9e0",
        brightCyan: "#7bd3c0", brightWhite: "#e8edf5",
      },
      providers: {
        claude: { cursor: "#c8825c", cursorAccent: "#140d09", selectionBackground: "#3a2a1e" },
        codex: { cursor: "#58b9a6", cursorAccent: "#081511", selectionBackground: "#1e3a33" },
      },
    },

    "still-air": {
      label: "Still Air",
      swatch: { bg: "#141517", accent: "#ffffff" },
      xterm: {
        background: CLEAR,
        foreground: "#b9bcc0",
        cursor: "#ffffff",
        cursorAccent: "#101113",
        selectionBackground: "#2a2d31",
        black: "#17181a", red: "#c07f74", green: "#8fa792", yellow: "#bfae8e",
        blue: "#8ea3b8", magenta: "#a795b3", cyan: "#88aaa2", white: "#c9cccf",
        brightBlack: "#5d6165", brightRed: "#d29a90", brightGreen: "#a8bfab",
        brightYellow: "#d4c5a7", brightBlue: "#a9bccd", brightMagenta: "#beafc9",
        brightCyan: "#a2c1ba", brightWhite: "#ffffff",
      },
      providers: {
        claude: { cursor: "#a08774", cursorAccent: "#141517", selectionBackground: "#2d2823" },
        codex: { cursor: "#6f958a", cursorAccent: "#141517", selectionBackground: "#222b28" },
      },
    },

    study: {
      label: "The Study",
      swatch: { bg: "#221418", accent: "#c9a35f" },
      xterm: {
        background: CLEAR,
        foreground: "#dccdb2",
        cursor: "#c9a35f",
        cursorAccent: "#1b0f12",
        selectionBackground: "#3d2b21",
        black: "#241419", red: "#c26a52", green: "#6d8f6a", yellow: "#c9a35f",
        blue: "#7d92ad", magenta: "#a97f9b", cyan: "#7fa091", white: "#e6d9c2",
        brightBlack: "#87715c", brightRed: "#d68a70", brightGreen: "#8aab86",
        brightYellow: "#dcbc7f", brightBlue: "#9cb0c7", brightMagenta: "#c29cb5",
        brightCyan: "#9dbcae", brightWhite: "#f6ecd9",
      },
      providers: {
        claude: { cursor: "#b5764d", cursorAccent: "#1b0f12", selectionBackground: "#3d281c" },
        codex: { cursor: "#6d8f6a", cursorAccent: "#1b0f12", selectionBackground: "#2a3527" },
      },
    },

    manifesto: {
      label: "Manifesto",
      swatch: { bg: "#0c0c0c", accent: "#e63b2e" },
      xterm: {
        background: CLEAR,
        foreground: "#cfcac1",
        cursor: "#e63b2e",
        cursorAccent: "#080808",
        selectionBackground: "#33302b",
        black: "#141414", red: "#e63b2e", green: "#5e9c8a", yellow: "#c8a656",
        blue: "#7f95a8", magenta: "#a98398", cyan: "#78a79a", white: "#e9e5dd",
        brightBlack: "#6b675f", brightRed: "#f0594c", brightGreen: "#7bb6a5",
        brightYellow: "#dcbd75", brightBlue: "#9cafc0", brightMagenta: "#c0a0b3",
        brightCyan: "#95c1b5", brightWhite: "#f7f4ee",
      },
      providers: {
        claude: { cursor: "#c96b4e", cursorAccent: "#080808", selectionBackground: "#38251d" },
        codex: { cursor: "#5e9c8a", cursorAccent: "#080808", selectionBackground: "#20312c" },
      },
    },

    meridian: {
      label: "Meridian",
      swatch: { bg: "#e6ecea", accent: "#1e9e8a" },
      // Light chrome, dark-pine terminal wells: a dark screen in a light
      // device. The ANSI set is tuned against the pine well, not the chrome.
      xterm: {
        background: CLEAR,
        foreground: "#cfe8e2",
        cursor: "#7fd4c1",
        cursorAccent: "#0e3230",
        selectionBackground: "#1e4a45",
        black: "#123734", red: "#e8875f", green: "#5fbfa5", yellow: "#d9b56a",
        blue: "#7fb2d9", magenta: "#b295c9", cyan: "#7fd4c1", white: "#d8ece7",
        brightBlack: "#5f8f88", brightRed: "#f0a07d", brightGreen: "#83d4bd",
        brightYellow: "#e8ca8b", brightBlue: "#a0c8e8", brightMagenta: "#c9b0dc",
        brightCyan: "#a2e2d3", brightWhite: "#f0fffb",
      },
      providers: {
        claude: { cursor: "#e8875f", cursorAccent: "#0e3230", selectionBackground: "#463228" },
        codex: { cursor: "#2f9e8f", cursorAccent: "#0e3230", selectionBackground: "#1c443f" },
      },
    },

    paper: {
      label: "Ledger Paper",
      swatch: { bg: "#faf9f5", accent: "#a33327" },
      // Ink on paper: a light terminal well with dark ink text and a red-ink
      // cursor. Brights stay darker than usual so they hold on the light well.
      xterm: {
        background: CLEAR,
        foreground: "#3a362e",
        cursor: "#a33327",
        cursorAccent: "#f6f4ee",
        selectionBackground: "#e3ddc9",
        black: "#17140f", red: "#a33327", green: "#4a6d5f", yellow: "#8a6a25",
        blue: "#3f5d7e", magenta: "#7c5570", cyan: "#3f6d63", white: "#6d675c",
        brightBlack: "#98917f", brightRed: "#c04a38", brightGreen: "#5d8875",
        brightYellow: "#a6822f", brightBlue: "#54779c", brightMagenta: "#96698a",
        brightCyan: "#54887c", brightWhite: "#2b2822",
      },
      providers: {
        claude: { cursor: "#9c5a38", cursorAccent: "#f6f4ee", selectionBackground: "#e8d9cc" },
        codex: { cursor: "#4a6d5f", cursorAccent: "#f6f4ee", selectionBackground: "#d9e2da" },
      },
    },

    matrix: {
      label: "The Matrix",
      swatch: { bg: "#020904", accent: "#72ff62" },
      // High-luminance phosphor without sacrificing ANSI distinctions. The
      // moving rain belongs to CSS and stays behind the near-solid pane well.
      xterm: {
        background: CLEAR,
        foreground: "#a7f7a0",
        cursor: "#d7ffd2",
        cursorAccent: "#020904",
        selectionBackground: "#174c21",
        black: "#031006", red: "#ff6b73", green: "#4ee45f", yellow: "#d8dc72",
        blue: "#58a6d6", magenta: "#c47acb", cyan: "#65d6b0", white: "#c8e8c4",
        brightBlack: "#427648", brightRed: "#ff8d93", brightGreen: "#8dff7d",
        brightYellow: "#f1f59a", brightBlue: "#82c8ee", brightMagenta: "#dda0e2",
        brightCyan: "#90efd0", brightWhite: "#efffed",
      },
      providers: {
        claude: { cursor: "#d6b86f", cursorAccent: "#020904", selectionBackground: "#3c3619" },
        codex: { cursor: "#72ff62", cursorAccent: "#020904", selectionBackground: "#174c21" },
      },
    },

    amber: {
      label: "Amber Terminal",
      swatch: { bg: "#120b02", accent: "#ffbd45" },
      xterm: {
        background: CLEAR,
        foreground: "#e8b85e",
        cursor: "#ffe2a1",
        cursorAccent: "#120b02",
        selectionBackground: "#593a0d",
        black: "#160d03", red: "#e66f45", green: "#8fb36a", yellow: "#e8b85e",
        blue: "#7c9fbd", magenta: "#ba7fa0", cyan: "#78ae9b", white: "#dbc494",
        brightBlack: "#7d6336", brightRed: "#f18a5e", brightGreen: "#abc985",
        brightYellow: "#ffd479", brightBlue: "#9bb9d0", brightMagenta: "#d19ab7",
        brightCyan: "#97c6b5", brightWhite: "#fff0c8",
      },
      providers: {
        claude: { cursor: "#e98b45", cursorAccent: "#120b02", selectionBackground: "#563016" },
        codex: { cursor: "#94c798", cursorAccent: "#120b02", selectionBackground: "#273d25" },
      },
    },

    blueprint: {
      label: "Blueprint",
      swatch: { bg: "#082b4b", accent: "#8edcff" },
      xterm: {
        background: CLEAR,
        foreground: "#c6eaff",
        cursor: "#ffffff",
        cursorAccent: "#06243e",
        selectionBackground: "#155580",
        black: "#072640", red: "#ff8f91", green: "#83d7bd", yellow: "#e8c978",
        blue: "#7dbbff", magenta: "#c7a5ed", cyan: "#7adcf2", white: "#d8effc",
        brightBlack: "#5d89a8", brightRed: "#ffabad", brightGreen: "#a4ead2",
        brightYellow: "#f4dd9a", brightBlue: "#a3d1ff", brightMagenta: "#ddc0fa",
        brightCyan: "#a4efff", brightWhite: "#ffffff",
      },
      providers: {
        claude: { cursor: "#ffb17e", cursorAccent: "#06243e", selectionBackground: "#60402b" },
        codex: { cursor: "#8edcff", cursorAccent: "#06243e", selectionBackground: "#155580" },
      },
    },

    "sakura-dusk": {
      label: "Sakura Dusk",
      swatch: { bg: "#1b111d", accent: "#ff7898" },
      xterm: {
        background: CLEAR,
        foreground: "#eadce7",
        cursor: "#ff8eaa",
        cursorAccent: "#160d19",
        selectionBackground: "#513044",
        black: "#1b111d", red: "#ef7180", green: "#78b99a", yellow: "#d7b36f",
        blue: "#879fd4", magenta: "#c587bd", cyan: "#77b8bd", white: "#e3d7e2",
        brightBlack: "#765f75", brightRed: "#ff91a0", brightGreen: "#98d1b3",
        brightYellow: "#e6c98f", brightBlue: "#a8bae6", brightMagenta: "#dfa6d5",
        brightCyan: "#98d0d3", brightWhite: "#fff6fd",
      },
      providers: {
        claude: { cursor: "#ef8a68", cursorAccent: "#160d19", selectionBackground: "#553023" },
        codex: { cursor: "#79c5b3", cursorAccent: "#160d19", selectionBackground: "#24443c" },
      },
    },
  };

  return {
    themes,
    DEFAULT_THEME: "glass",
    termTheme(themeId, provider) {
      const theme = themes[themeId] ?? themes.glass;
      const base = theme.xterm;
      const overlay = provider ? theme.providers[provider] : null;
      return overlay ? { ...base, ...overlay } : { ...base };
    },
  };
});
