import * as React from 'react';

export const DirectoryInput = ({
  className,
  disabled,
  onFiles,
}: {
  className?: string;
  disabled: boolean;
  onFiles: (files: File[]) => void;
}) => {
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.setAttribute('webkitdirectory', '');
    el.setAttribute('directory', '');
  }, []);

  return (
    <input
      ref={inputRef}
      className={className}
      type="file"
      multiple
      disabled={disabled}
      onChange={(e) => onFiles(Array.from(e.currentTarget.files ?? []))}
    />
  );
};
