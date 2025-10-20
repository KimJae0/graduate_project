/**
 * export_facedist.js (Node backend 전용)
 * 얼굴 감정 추출 + CSV 저장
 */

const tf = require('@tensorflow/tfjs-node'); // ✅ Node 환경에서는 무조건 이거
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const canvas = require('canvas');
const faceapi = require('face-api.js');

faceapi.tf = tf;
const { Canvas, Image, ImageData } = canvas;
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

const EMOS = ["neutral","happy","sad","angry","fearful","disgusted","surprised"];

function arg(k, def=null) {
  const i = process.argv.indexOf(k);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i+1];
  return def;
}

const CSV_PATH   = arg('--csv');
const OUT_PATH   = arg('--out', 'out/facedist.csv');
const IMG_COL    = arg('--img-col', 'path');
const LABEL_COL  = arg('--label-col', 'label');
const GENDER_COL = arg('--gender-col', 'gender');
const MODEL_DIR  = arg('--model-dir', 'models');

if (!CSV_PATH) {
  console.error('Usage: node export_facedist.js --csv data/list.csv --out out/facedist.csv');
  process.exit(1);
}

(async () => {
  // ✅ backend 확인
  await tf.setBackend('tensorflow');
  await tf.ready();
  console.log('[tf] backend:', tf.getBackend());

  // ✅ 모델 로드
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_DIR);
  await faceapi.nets.faceExpressionNet.loadFromDisk(MODEL_DIR);

  const content = fs.readFileSync(CSV_PATH, 'utf-8');
  const rows = parse(content, { columns: true, skip_empty_lines: true });

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const header = [
    'path','y_true','gender','face_found',
    ...EMOS.map(e => `p_${e}`)
  ];
  fs.writeFileSync(OUT_PATH, header.join(',') + '\n');

  const { createCanvas, loadImage } = canvas;
  let processed = 0, found = 0;

  for (const r of rows) {
    const imgPath = r[IMG_COL];
    const yTrue = (r[LABEL_COL] || '').toLowerCase().trim();
    const gender = (r[GENDER_COL] || 'unknown').toLowerCase().trim() || 'unknown';

    let probs = EMOS.map(_ => 0);
    let faceFound = 0;

    try {
      const img = await loadImage(imgPath);
      const c = createCanvas(img.width, img.height);
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);

      const det = await faceapi.detectSingleFace(c).withFaceExpressions();
      if (det && det.expressions) {
        faceFound = 1;
        probs = EMOS.map(e => Number(det.expressions[e] || 0));
        const sum = probs.reduce((a,b)=>a+b,0) || 1;
        probs = probs.map(v => v/sum);
        found++;
      }
    } catch (e) {
      console.error(`Error processing ${imgPath}:`, e.message);
    }

    const line = [
      JSON.stringify(imgPath),
      yTrue, gender, faceFound,
      ...probs.map(v => v.toFixed(6))
    ].join(',');
    fs.appendFileSync(OUT_PATH, line + '\n');

    processed++;
    if (processed % 20 === 0) console.log(`Processed ${processed}/${rows.length}, faces: ${found}`);
  }

  console.log(`✅ Done. Wrote ${OUT_PATH}. total=${processed} faces=${found}`);
})();
