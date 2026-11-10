/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/**/*.{html,js,jsx}'],
  theme: {
    extend: {
      colors: {
        base: '#0a0a0c',        // 墨黑
        card: '#111114',
        cardHover: '#17171b',
        edge: '#26262c',
        ink: '#ece7dc',         // 宣纸白（文字）
        mute: '#9a938a',
        gold: '#c9a227',        // 鎏金主色
        goldSoft: '#e3c56b',
        goldDeep: '#8f741d',
        jade: '#3f9e6e'         // 通过绿（语义色）
      },
      fontFamily: {
        kai: ['KaiTi', 'STKaiti', '楷体', 'Noto Serif SC', 'serif'],
        song: ['Noto Serif SC', 'STSong', 'SimSun', 'serif']
      }
    },
  },
  plugins: []
};
