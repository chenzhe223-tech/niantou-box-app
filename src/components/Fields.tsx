import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from './Icon';

export interface FieldShellProps {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string | null;
  /** 是否隐藏标签的视觉呈现（仍保留给屏幕阅读器）。 */
  hideLabel?: boolean;
  children: ReactNode;
  className?: string;
}

export function FieldShell({
  label,
  htmlFor,
  hint,
  error,
  hideLabel,
  children,
  className,
}: FieldShellProps) {
  return (
    <div className={['nb-field', className].filter(Boolean).join(' ')}>
      <label className={hideLabel ? 'nb-field__label nb-visually-hidden' : 'nb-field__label'} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <p className="nb-field__hint">{hint}</p> : null}
      {error ? (
        <p className="nb-field__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  error?: string | null;
  type?: 'text' | 'url' | 'search' | 'email';
  hideLabel?: boolean;
  inputMode?: 'text' | 'url' | 'search' | 'email';
  autoComplete?: string;
  id?: string;
  disabled?: boolean;
  maxLength?: number;
  autoFocus?: boolean;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  error,
  type = 'text',
  hideLabel = false,
  inputMode,
  autoComplete,
  id,
  disabled,
  maxLength,
  autoFocus,
  onKeyDown,
}: TextFieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  return (
    <FieldShell label={label} htmlFor={fieldId} hint={hint} error={error} hideLabel={hideLabel}>
      <input
        id={fieldId}
        className="nb-input"
        type={type}
        value={value}
        placeholder={placeholder}
        inputMode={inputMode}
        autoComplete={autoComplete}
        disabled={disabled}
        maxLength={maxLength}
        autoFocus={autoFocus}
        onKeyDown={onKeyDown}
        onChange={(event) => onChange(event.target.value)}
      />
    </FieldShell>
  );
}

export interface TextAreaProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  error?: string | null;
  rows?: number;
  autoFocus?: boolean;
  hideLabel?: boolean;
  id?: string;
  className?: string;
  maxLength?: number;
}

export function TextArea({
  label,
  value,
  onChange,
  placeholder,
  hint,
  error,
  rows = 4,
  autoFocus,
  hideLabel = false,
  id,
  className,
  maxLength,
}: TextAreaProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  return (
    <FieldShell
      label={label}
      htmlFor={fieldId}
      hint={hint}
      error={error}
      hideLabel={hideLabel}
      className={className}
    >
      <textarea
        id={fieldId}
        className="nb-textarea"
        value={value}
        rows={rows}
        placeholder={placeholder}
        autoFocus={autoFocus}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
      />
    </FieldShell>
  );
}

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

export interface SelectFieldProps<T extends string> {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<SelectOption<T>>;
  hint?: string;
  hideLabel?: boolean;
  id?: string;
}

export function SelectField<T extends string>({
  label,
  value,
  onChange,
  options,
  hint,
  hideLabel = false,
  id,
}: SelectFieldProps<T>) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  return (
    <FieldShell label={label} htmlFor={fieldId} hint={hint} hideLabel={hideLabel}>
      <select
        id={fieldId}
        className="nb-select"
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export interface TagInputFieldProps {
  label: string;
  tags: string[];
  onChange: (tags: string[]) => void;
  hint?: string;
  placeholder?: string;
}

/** 标签输入：回车或逗号确认一个标签，可逐个删除。 */
export function TagInputField({
  label,
  tags,
  onChange,
  hint,
  placeholder = '输入后按回车添加标签',
}: TagInputFieldProps) {
  const [draft, setDraft] = useState('');
  const fieldId = useId();

  const commit = () => {
    const value = draft.trim().replace(/[,，]$/, '');
    if (value === '') return;
    if (!tags.includes(value)) {
      onChange([...tags, value]);
    }
    setDraft('');
  };

  return (
    <FieldShell label={label} htmlFor={fieldId} hint={hint}>
      <div className="nb-taginput">
        {tags.length > 0 ? (
          <ul className="nb-taginput__list">
            {tags.map((tag) => (
              <li key={tag} className="nb-tag">
                <span>{tag}</span>
                <button
                  type="button"
                  className="nb-tag__remove"
                  aria-label={`移除标签 ${tag}`}
                  onClick={() => onChange(tags.filter((item) => item !== tag))}
                >
                  <Icon name="close" size={12} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <input
          id={fieldId}
          className="nb-input nb-taginput__input"
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
              event.preventDefault();
              commit();
            } else if (event.key === 'Backspace' && draft === '' && tags.length > 0) {
              onChange(tags.slice(0, -1));
            }
          }}
          onBlur={commit}
        />
      </div>
    </FieldShell>
  );
}
