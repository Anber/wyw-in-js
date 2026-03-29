import { classes, reproMeta } from './generated';

function App() {
  return (
    <main
      style={{
        display: 'grid',
        gap: '0.75rem',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        padding: '2rem',
      }}
    >
      <div>
        <strong>issue #256 repro</strong>
        <div>
          exports: {reproMeta.exportsCount}, consumers: {reproMeta.consumerCount}
        </div>
      </div>
      {classes.slice(0, 12).map((className, index) => (
        <div
          key={className}
          className={className}
          style={{ borderStyle: 'solid', borderWidth: '2px', padding: '0.75rem' }}
        >
          generated consumer {index}
        </div>
      ))}
    </main>
  );
}

export default App;
