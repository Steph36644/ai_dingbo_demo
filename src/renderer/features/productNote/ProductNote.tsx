import { useEffect, useState } from "react";

const LIMIT = 500;

export function ProductNote({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <div className="product-note">
      <textarea
        className="product-note-input"
        value={draft}
        maxLength={LIMIT}
        disabled={disabled}
        placeholder="本场商品口径、价格、库存提醒……"
        aria-label="本场备注"
        onChange={(event) => {
          setDraft(event.target.value);
          onChange(event.target.value);
        }}
      />
      <div className="product-note-foot">
        <span>仅本场备注，不显示在大屏</span>
        <span>
          {draft.length}/{LIMIT}
        </span>
      </div>
    </div>
  );
}
