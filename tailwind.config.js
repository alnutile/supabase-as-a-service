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
        // `brand` kept (repointed to the SupaNet green ramp) so any leftover
        // brand-* class still renders on-palette after the token sweep.
        brand: {
          50: '#eaf7f0',
          100: '#c7e7d6',
          200: '#9bd9ba',
          300: '#7fd7aa',
          400: '#3ecf8e',
          500: '#15795b',
          600: '#15795b',
          700: '#0f5e46',
          800: '#0c4736',
          900: '#0e1f18',
        },
      },
      fontFamily: {
        sans: ['"Schibsted Grotesk"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        soft: '0 1px 2px rgba(14,31,24,.04), 0 6px 18px rgba(14,31,24,.05)',
        'soft-lg': '0 6px 16px rgba(14,31,24,.07), 0 22px 48px rgba(14,31,24,.10)',
      },
      keyframes: {
        fadeUp: { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'none' } },
        // Subtle "typing" dot: lifts and brightens on the beat, settles between.
        typingBounce: {
          '0%, 80%, 100%': { transform: 'translateY(0)', opacity: '0.35' },
          '40%': { transform: 'translateY(-4px)', opacity: '1' },
        },
      },
      animation: {
        fadeUp: 'fadeUp .3s ease',
        typingBounce: 'typingBounce 1.2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
