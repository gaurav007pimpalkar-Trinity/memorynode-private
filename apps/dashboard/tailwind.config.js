/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      keyframes: {
        "auth-panel-in": {
          "0%": { opacity: "0", transform: "translateX(-6px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        "auth-form-in": {
          "0%": { opacity: "0", transform: "scale(0.985)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
      },
      animation: {
        "auth-panel-in": "auth-panel-in 180ms ease-out both",
        "auth-form-in": "auth-form-in 180ms ease-out both",
      },
    },
  },
  plugins: [],
};
