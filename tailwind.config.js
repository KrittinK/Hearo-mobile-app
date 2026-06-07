module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Deaf Flag / Hearo brand palette
        navy: {
          DEFAULT: '#1E3FB8',
          50:  '#EEF1FC',
          100: '#D5DCF7',
          200: '#AABABF',
          300: '#6B8DE0',
          400: '#4A6DD4',
          500: '#1E3FB8',
          600: '#1835A0',
          700: '#132B88',
          800: '#0E2070',
          900: '#091558',
        },
        brand: {
          cyan:   '#00A8E1',
          yellow: '#FFE600',
          navy:   '#1E3FB8',
        },
        green: {
          50: '#f0fdf4', 100: '#dcfce7', 200: '#bbf7d0', 300: '#86efac',
          400: '#4ade80', 500: '#22c55e', 600: '#16a34a', 700: '#15803d',
          800: '#166534', 900: '#14532d',
        },
      },
    },
  },
  plugins: [],
};
