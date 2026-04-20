import * as React from 'react';

export const DirectoryInput = ({
  className,
  onChange,
  onFiles,
  ...rest
}: {
  onFiles: (files: File[]) => void;
} & Omit<React.ComponentPropsWithoutRef<'input'>, 'multiple' | 'type'>) => {
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
      multiple
      type="file"
      onChange={(e) => {
        onChange?.(e);
        onFiles(Array.from(e.currentTarget.files ?? []));
      }}
      {...rest}
    />
  );
};
