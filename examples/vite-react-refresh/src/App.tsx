import { css } from '@wyw-in-js/template-tag-syntax';

const box = css`
  padding: 1.5rem;
  border-radius: 0.75rem;
  background: linear-gradient(135deg, #f3ec78, #af4261);
  color: #1c1c28;
  font-weight: 700;
`;

function App() {
  return (
    <div className={box}>
      <p>WyW-in-JS + Vite React Refresh repro</p>
    </div>
  );
}

export default App;
