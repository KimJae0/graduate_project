import React from "react";

export const EMOTIONS = [
  "neutral", "happy", "sad", "angry", "fearful", "disgusted", "surprised",
];

const labels = {
  neutral: "중립", happy: "행복", sad: "슬픔",
  angry: "분노", fearful: "두려움", disgusted: "혐오", surprised: "놀람",
};

export default function EmotionPicker({ value, onChange }) {
  return (
    <div style={{ display:"flex", gap:12, flexWrap:"wrap", alignItems:"center", margin:"8px 0 12px" }}>
      <strong>내 감정 선택:</strong>
      {EMOTIONS.map((e) => (
        <label key={e} style={{ display:"flex", gap:6, alignItems:"center" }}>
          <input
            type="radio"
            name="user-emotion"
            value={e}
            checked={value === e}
            onChange={(ev) => onChange(ev.target.value)}
          />
          {labels[e]}
        </label>
      ))}
      <button type="button" onClick={() => onChange(null)} style={{ marginLeft: 8 }}>
        선택 해제
      </button>
    </div>
  );
}
