interface FastModeFieldProps {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
}

export default function FastModeField({
  checked,
  disabled = false,
  onChange,
  className,
}: FastModeFieldProps) {
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded border border-kumo-line px-3 py-2 ${className ?? ""}`}>
      <input
        type="checkbox"
        aria-label="Fast mode"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        disabled={disabled}
        className="mt-0.5"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-kumo-default">Fast mode</span>
        <span className="block text-xs text-kumo-subtle">
          Runs the selected model faster at a higher usage rate.
        </span>
      </span>
    </label>
  );
}
