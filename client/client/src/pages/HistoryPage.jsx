import React, { useEffect, useState } from 'react';

export default function HistoryPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const res = await fetch('http://localhost:5000/history/recsets?page=1&pageSize=20');
    const data = await res.json();
    setRows(data.items || []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  if (loading) return <div style={{padding:16}}>불러오는 중…</div>;

  return (
    <div style={{padding:16, display:'grid', gap:16}}>
      <h2>기록 확인</h2>
      {rows.length === 0 && <div>기록이 없습니다.</div>}

      {rows.map(rec => (
        <div key={rec.id} style={{border:'1px solid #ddd', borderRadius:8, padding:12}}>
          <div style={{display:'flex', justifyContent:'space-between', gap:8, flexWrap:'wrap'}}>
            <div>
              <b>세트 #{rec.id}</b> · {new Date(rec.createdAt).toLocaleString()}
              {rec.emotion && <> · 감정:{rec.emotion}</>}
              {rec.age != null && <> · 나이:{rec.age}</>}
              {rec.gender && <> · 성별:{rec.gender}</>}
            </div>
            {rec.push
              ? <span>전송됨 #{rec.push.id} · {new Date(rec.push.pushedAt).toLocaleTimeString()}</span>
              : <span style={{opacity:.6}}>전송 안됨</span>}
          </div>

          <div style={{display:'grid', gap:8, marginTop:8}}>
            {rec.items.map((it, idx) => {
              const sent = rec.push && rec.push.selectedIdx === idx;
              return (
                <div key={idx} style={{
                  padding:'8px 10px',
                  border:'1px solid ' + (sent ? '#4caf50' : '#eee'),
                  borderRadius:6,
                  background: sent ? '#e8f5e9' : '#fafafa'
                }}>
                  <b>{idx+1}. {it.title} - {it.artist}</b>
                  {it.reasonShort && <div style={{fontSize:13, opacity:.8}}>{it.reasonShort}</div>}
                  {sent && <div style={{fontSize:12, color:'#2e7d32'}}>✅ 이 곡이 전송됨</div>}
                </div>
              );
            })}
          </div>

          {rec.push?.message && (
            <div style={{marginTop:8, padding:8, background:'#f5f5f5', borderRadius:6}}>
              <b>보낸 메시지:</b> {rec.push.message}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
