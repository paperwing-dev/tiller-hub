import { PLAN_MODEL_OPTIONS, isChatGPTPlanModel } from "./plan-models";

interface AddReviewerMenuProps {
  activeReviewerCount: number;
  disabled?: boolean;
  onAdd: (model: string) => void;
}

export default function AddReviewerMenu({ activeReviewerCount, disabled = false, onAdd }: AddReviewerMenuProps) {
  const available = PLAN_MODEL_OPTIONS
    .filter((option) => !isChatGPTPlanModel(option.id));

  if (activeReviewerCount >= 4) {
    return (
      <button
        disabled
        className="rounded border border-[#d0d7de] bg-[#f6f8fa] px-2 py-1 text-xs text-[#8c959f]"
        title="Reviewer limit reached"
      >
        +
      </button>
    );
  }

  return (
    <select
      value=""
      disabled={disabled || available.length === 0}
      onChange={(event) => {
        const model = event.target.value;
        if (model) onAdd(model);
      }}
      className="rounded border border-[#d0d7de] bg-white px-2 py-1 text-xs text-[#57606a] disabled:opacity-40"
      title="Add reviewer"
    >
      <option value="">+</option>
      {available.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
