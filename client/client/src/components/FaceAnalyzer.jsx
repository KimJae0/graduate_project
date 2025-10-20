import React, { useRef, useEffect, useState, forwardRef, useImperativeHandle } from 'react';
import * as faceapi from 'face-api.js';

const FaceAnalyzer = forwardRef(({ active, setRecommendations, setLoading, userEmotion, trait, nostalgiaOn }, ref) => {
  const videoRef = useRef(null);
  const [analysis, setAnalysis] = useState('카메라 준비 중…');
  const [lastFace, setLastFace] = useState(null);
  const [ready, setReady] = useState(false); // ✅ 카메라 준비 상태

  const loadModels = async () => {
    await faceapi.nets.ssdMobilenetv1.loadFromUri('/models');
    await faceapi.nets.faceExpressionNet.loadFromUri('/models');
    await faceapi.nets.ageGenderNet.loadFromUri('/models');
  };

  const startVideo = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: {} });
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await new Promise((resolve) => {
        videoRef.current.onloadedmetadata = () => {
          videoRef.current.play().then(resolve);
        };
      });
    }
  };

  const analyzeFace = async () => {
    const det = await faceapi
      .detectSingleFace(videoRef.current, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.4 }))
      .withFaceExpressions()
      .withAgeAndGender();

    if (!det) {
      setAnalysis('얼굴을 찾지 못했습니다.');
      return null;
    }

    const { age, gender, expressions } = det;
    const dominantExpression = Object.entries(expressions).reduce((a, b) => (a[1] > b[1] ? a : b))[0];
    const genderKo = gender === 'male' ? '남자' : '여자';
    setAnalysis(`성별: ${genderKo}, 나이(예상): ${Math.round(age)}, 감정: ${dominantExpression}`);

    return {
      age: Math.round(age),
      gender,
      emotion: dominantExpression,
      faceDist: expressions,
      quality: 0.8
    };
  };

  const getRecommendations = async () => {
    if (!ready) {
      console.warn('카메라 준비가 아직 안됨');
      return;
    }

    setLoading?.(true);
    let faceInfo = await analyzeFace();
    if (!faceInfo) faceInfo = lastFace;

    try {
      const res = await fetch('http://localhost:5000/recommend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          age: faceInfo?.age ?? null,
          gender: faceInfo?.gender ?? null,
          emotion: faceInfo?.emotion ?? userEmotion,
          faceDist: faceInfo?.faceDist ?? null,
          quality: faceInfo?.quality ?? 0.5,
          userEmotion,
          trait,
          nostalgia: nostalgiaOn ? 1 : 0
        })
      });
      const data = await res.json();
      setRecommendations(Array.isArray(data.recommendations) ? data.recommendations : []);
    } catch (err) {
      console.error(err);
      setRecommendations([]);
    } finally {
      setLoading?.(false);
    }
  };

  // Home에서 호출 가능하게 ref 노출
  useImperativeHandle(ref, () => ({
    requestRecommendations: getRecommendations
  }));

  // active가 true일 때 카메라 시작
  useEffect(() => {
    if (!active) return;
    (async () => {
      try {
        await loadModels();
        await startVideo();
        setReady(true); // ✅ 카메라 준비 완료 표시
      } catch (e) {
        console.error(e);
        setAnalysis('카메라/모델 로드 실패');
      }
    })();
  }, [active]); 

  return (
    <div>
      {active ? (
        <>
          <video ref={videoRef} autoPlay muted width="400" height="300" />
          <p>{analysis}</p>
        </>
      ) : (
        <p>카메라 준비 전 (버튼을 눌러 시작하세요)</p>
      )}
    </div>
  );
});

export default FaceAnalyzer;
