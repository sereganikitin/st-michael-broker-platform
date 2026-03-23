/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        background: '#0c0b0b',
        surface: '#111010',
        'surface-secondary': '#181716',
        accent: '#B4936F',
        'accent-hover': '#c9a882',
        text: '#ffffff',
        'text-muted': '#7a7672',
        success: '#6dbf8e',
        error: '#a05050',
        warning: '#d4a05b',
        info: '#5b8fd4',
        border: 'rgba(255,255,255,0.08)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      letterSpacing: {
        tight: '-0.02em',
        normal: '0',
        wide: '0.02em',
      },
    },
  },
  plugins: [],
};