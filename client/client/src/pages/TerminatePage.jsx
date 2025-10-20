import React from 'react';
import { Link } from 'react-router-dom';

export default function TerminatePage() {
  return (
    <div
      style={{
        backgroundColor: '#67b6ebff',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center'
      }}
    >
      <h1>모든 인원이 노래를 전송했습니다.</h1>
      <Link to="/history">
        <button style={{margin : 45}}>기록 확인하기</button>
      </Link>
    </div>
  );
}
