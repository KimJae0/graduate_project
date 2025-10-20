import React, { useEffect, useState, useRef } from 'react';
import { Routes, Route, Link, useNavigate } from 'react-router-dom';
import FaceAnalyzer from './components/FaceAnalyzer';
import HistoryPage from './pages/HistoryPage.jsx';
import { ClipLoader } from 'react-spinners';
import EmotionPicker from './components/EmotionPicker.jsx';
import PersonalityPicker from './components/PersonalityPicker.jsx';
import TerminatePage from './pages/TerminatePage.jsx';
import './App.css';

function Home() {
  const [step, setStep] = useState("input"); // "input" | "analyze"
  const [totalUsers, setTotalUsers] = useState(0);
  const [currentUser, setCurrentUser] = useState(0);
  const [analyzeActive, setAnalyzeActive] = useState(false);

  const [recommendations, setRecommendations] = useState([]);
  const [message, setMessage] = useState('');
  const [recSetId, setRecSetId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [userEmotion, setUserEmotion] = useState(null);
  const [nostalgiaOn, setNostalgiaOn] = useState(false);
  const [trait, setTrait] = useState(null); // 'introvert' | 'extrovert' | null
  const firstClick = useRef(false);
  const [text, setText] = useState('카메라 켜기');

  const navigate = useNavigate();
  const faceAnalyzerRef = useRef(null);

  // 추천 결과 저장
  useEffect(() => {
    if (!recommendations?.length) {
      setRecSetId(null);
      return;
    }
    (async () => {
      try {
        const body = {
          age: null,
          gender: null,
          emotion: null,
          items: recommendations.map(r => ({
            title: r.title,
            artist: r.artist,
            spotifyId: r.spotifyId || '',
            youtubeUrl: r.youtubeUrl || '',
            reasonShort: r.reason || ''
          }))
        };
        const res = await fetch('http://localhost:5000/recsets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (data.ok) setRecSetId(data.id);
      } catch (e) {
        console.warn('recsets save fail', e);
      }
    })();
  }, [recommendations]);

  // 스트리밍 전송
  const sendToStream = async (rec, idx) => {
    try {
      await fetch('http://localhost:5000/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: 'default',
          song: {
            title: rec.title,
            artist: rec.artist,
            youtubeUrl: rec.youtubeUrl || '',
            spotifyId: rec.spotifyId || ''
          },
          message,
          recSetId,
          selectedIdx: idx
        }),
      });
      alert('스트리밍 화면으로 전송했어요!');
    } catch (e) {
      console.error(e);
      alert('전송 실패: 서버 확인 필요');
    }
  };

  // 1단계: 사용자 수 입력
  if (step === "input") {
    return (
      <div style={{ textAlign: "center", marginTop: "100px" }}>
        <h2>오늘 참여할 사용자 수를 입력하세요</h2>
        <input
          type="number"
          min="1"
          value={totalUsers}
          onChange={(e) => setTotalUsers(Number(e.target.value))}
          style={{ padding: "8px", fontSize: "16px", marginRight: "8px" }}
        />
        <button
          onClick={() => totalUsers > 0 && setStep("analyze")}
          style={{ padding: "10px 20px", backgroundColor: '#3498db', fontWeight: 'bold' }}
        >
          OK
        </button>
      </div>
    );
  }

  // 2단계: 감정인식 및 추천
  return (
    <div className="app-container">
      <div className="left-pane">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h1>🎵 얼굴 인식 기반 노래 추천 🎵</h1>
          <Link to="/history"><button>기록 확인하기</button></Link>
        </div>

        <p>총 사용자: {totalUsers}명 · 현재 {currentUser}번 사용자 차례</p>

        {/* 감정 선택 UI */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <EmotionPicker value={userEmotion} onChange={setUserEmotion} />
          <PersonalityPicker value={trait} onChange={setTrait} />
          <button
            type="button"
            onClick={() => setNostalgiaOn(v => !v)}
            aria-pressed={nostalgiaOn}
            title="내 10대 시절 발매곡 위주로 추천"
            style={{
              padding: '6px 10px',
              borderRadius: 8,
              border: '1px solid #ddd',
              background: nostalgiaOn ? '#ffe599' : '#eee',
              cursor: 'pointer'
            }}
          >
            추억의 노래 {nostalgiaOn ? 'ON' : 'OFF'}
          </button>
        </div>

        {/* 카메라 시작 + 추천 호출 버튼 */}
        <button
          onClick={() => {
            setAnalyzeActive(true);

            if (!firstClick.current) {
              // 첫 번째 클릭
              firstClick.current = true;
              setText('감정 인식 시작');

            } else {
              // 두 번째 이후 클릭은 currentUser 증가
              setCurrentUser(prev => prev + 1);
            }

            if(currentUser === totalUsers - 1){
              setText('감정 인식 종료')
            }

            // 카메라 준비 후 추천 요청
            setTimeout(() => {
              if (faceAnalyzerRef.current) {
                faceAnalyzerRef.current.requestRecommendations();
              }
            }, 800);

            if (currentUser === totalUsers) {
              navigate('/TerminatePage');
            }
          }}
        >
          {text}
        </button>


        <FaceAnalyzer
          ref={faceAnalyzerRef}
          active={analyzeActive}
          setRecommendations={setRecommendations}
          setLoading={setLoading}
          userEmotion={userEmotion}
          trait={trait}
          nostalgiaOn={nostalgiaOn}
        />

        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <ClipLoader size={18} />
            <span style={{ color: '#666' }}>추천 불러오는 중…</span>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
          <input
            placeholder="스트리밍 화면에 함께 띄울 메시지"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            style={{ flex: 1, padding: '10px 12px' }}
          />
        </div>

        <h3>🎵 추천 곡</h3>
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {recommendations.length > 0 ? (
            recommendations.map((rec, idx) => (
              <li
                key={idx}
                style={{
                  marginBottom: '12px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 12
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      padding: '2px 6px',
                      borderRadius: '6px',
                      fontSize: '0.75rem',
                      fontWeight: 'bold',
                      color: 'white',
                      backgroundColor: rec.category === '공감' ? '#f1c40f' : '#3498db'
                    }}
                  >
                    {rec.category}
                  </span>
                  <strong>{rec.title} - {rec.artist}</strong>
                </div>

                <button onClick={() => sendToStream(rec, idx)}>노래 전송</button>
              </li>
            ))
          ) : (
            <li style={{ padding: '36px 0' }}>
              <span style={{ color: '#888' }}>감정을 선택하고 버튼을 눌러주세요</span>
            </li>
          )}
        </ul>
      </div>

      <div className="right-pane">
        <h2>추천 이유</h2>
        <div id="reasons-container">
          {recommendations.length > 0 ? (
            recommendations.map((rec, idx) => (
              <div key={idx} style={{ marginBottom: '16px' }}>
                <strong>{rec.title}</strong>
                <p style={{ fontSize: '0.9rem', color: '#555', marginTop: '4px' }}>
                  {rec.reason || '추천 이유를 불러오지 못했습니다.'}
                </p>
              </div>
            ))
          ) : (
            <p style={{ color: '#888' }}>추천 이유가 없습니다.</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/history" element={<HistoryPage />} />
      <Route path="/TerminatePage" element={<TerminatePage />} />
    </Routes>
  );
}
