import React from "react";

export default function PersonalityPicker({ value, onChange }) {
  return (
    <div style={{ display:"flex", gap:12, alignItems:"center", margin:"8px 0 12px" }}>
      <strong>내 성향:</strong>
      {[
        { key: "introvert", label: "내향" },
        { key: "extrovert", label: "외향" },
      ].map(opt => (
        <label key={opt.key} style={{ display:"flex", gap:6, alignItems:"center" }}>
          <input
            type="radio"
            name="trait"
            value={opt.key}
            checked={value === opt.key}
            onChange={(e) => onChange(e.target.value)}
          />
          {opt.label}
        </label>
      ))}
      <button type="button" onClick={() => onChange(null)} style={{ marginLeft: 8 }}>
        선택 해제
      </button>
    </div>
  );
}
