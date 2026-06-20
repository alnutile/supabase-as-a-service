/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  // Dark mode is driven by data-theme="dark" on <html> (set by the theme toggle).
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // Semantic, theme-aware tokens (resolve to CSS vars defined in index.css).
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        'surface-hover': 'var(--surface-hover)',
        border: 'var(--border)',
        'border-strong': 'var(--border-strong)',
        text: 'var(--text)',
        muted: 'var(--muted)',
        faint: 'var(--faint)',
        primary: {
          DEFAULT: 'var(--primary)',
          strong: 'var(--primary-strong)',
          soft: 'var(--primary-soft)',
          'soft-border': 'var(--primary-soft-border)',
        },
        success: { DEFAULT: 'var(--success)', soft: 'var(--success-soft)' },
        warn: { DEFAULT: 'var(--warn)', soft: 'var(--warn-soft)' },
        info: { DEFAULT: 'var(--info)', soft: 'var(--info-soft)' },
        // `brand` kept (repointed to the purple ramp) so any leftover brand-* class
        // still renders on-palette after the token sweep.
        brand: {
          50: '#eeebfc',
          100: '#ddd6fb',
          200: '#c7bdf7',
          300: '#a99cf1',
          400: '#8a7dff',
          500: '#6354e8',
          600: '#6354e8',
          700: '#5443d8',
          800: '#4636bf',
          900: '#382c99',
        },
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        soft: '0 1px 2px rgba(34,26,60,.04), 0 6px 18px rgba(34,26,60,.05)',
        'soft-lg': '0 6px 16px rgba(34,26,60,.07), 0 22px 48px rgba(34,26,60,.10)',
      },
      keyframes: {
        fadeUp: { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'none' } },
      },
      animation: { fadeUp: 'fadeUp .3s ease' },
    },
  },
  plugins: [],
}
