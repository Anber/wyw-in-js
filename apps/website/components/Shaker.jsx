import React from 'react';
import dedent from 'dedent';
import { shake } from "wyw_wasm";
import Editor, { useMonaco } from '@monaco-editor/react';

import styles from './shaker.module.css';

const Panels = () => {
  const monaco = useMonaco();

  console.log("monaco", monaco);

  const [input, setInput] = React.useState(dedent`
    const a = 1;
    const b = 2;
    export { a, b };
             ^
  `);

  const [output, setOutput] = React.useState("");

  const handleEditorChange = React.useCallback((value, event) => {
    setInput(value);
  }, []);

  const handleEditorValidation = React.useCallback((markers) => {
    console.log("onValidate", markers);
  }, []);

  React.useEffect(() => {
    try {
      const result = shake(input);
      setOutput(result);
    } catch (e) {
      setOutput(e.toString());
    }
  }, [input]);

  return (
    <>
      <Editor
        height="90vh"
        className={styles.input}
        defaultLanguage="javascript"
        defaultValue={input}
        onChange={handleEditorChange}
        onValidate={handleEditorValidation}
      />;

      <pre className={styles.output}>{output}</pre>
    </>
  )
};

export const Shaker = () => {
  return <div className={styles.page}><Panels/></div>
};
