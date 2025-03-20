import path = require("path");
import { getFingerprints } from "./getFingerprints";
import * as fs from 'fs';

/**
 * 查找音频A在音频B中的位置
 * @param fingerprintsA 音频A的指纹
 * @param fingerprintsB 音频B的指纹
 * @param options 配置选项
 * @returns 匹配结果
 */
interface Fingerprint {
  time: number;
  hash: number; 
}

interface MatchResult {
  offset: number;       // 音频A在音频B中的开始时间（秒）
  matchCount: number;   // 匹配的指纹数量
  matchRate: number;    // 匹配率
  confidence: number;   // 置信度
  matches: Array<{      // 匹配的详细信息
    hashA: number;     
    timeA: number;
    timeB: number;
  }>;
}

function findAudioPosition(
  fingerprintsA: Fingerprint[], 
  fingerprintsB: Fingerprint[],
  options = { confidenceThreshold: 5, binSize: 0.05 }
): MatchResult {
  // 创建哈希表以加速查找
  const hashMapB = new Map<number, number[]>();
  
  // 为音频B的每个哈希值建立索引
  for (const fp of fingerprintsB) {
    if (!hashMapB.has(fp.hash)) {
      hashMapB.set(fp.hash, []);
    }
    hashMapB.get(fp.hash)!.push(fp.time);
  }
  
  // 存储时间偏移
  const offsetBins: Record<string, number> = {};
  const matchDetails: Array<{hashA: number, timeA: number, timeB: number, offset: number}> = [];
  
  // 对每个指纹A查找匹配的指纹B
  for (const fpA of fingerprintsA) {
    const matchingTimesB = hashMapB.get(fpA.hash);
    
    if (matchingTimesB) {
      for (const timeB of matchingTimesB) {
        const offset = timeB - fpA.time;
        
        // 将偏移量分箱以处理微小的时间差异
        const binKey = Math.round(offset / options.binSize) * options.binSize;
        const binKeyStr = binKey.toString();
        offsetBins[binKeyStr] = (offsetBins[binKeyStr] || 0) + 1;
        
        matchDetails.push({
          hashA: fpA.hash,
          timeA: fpA.time,
          timeB: timeB,
          offset: offset
        });
      }
    }
  }
  
  // 找到最频繁的偏移
  let bestOffset = 0;
  let maxCount = 0;
  
  for (const [offset, count] of Object.entries(offsetBins)) {
    if (count > maxCount) {
      maxCount = count;
      bestOffset = parseFloat(offset);
    }
  }
  
  // 筛选与最佳偏移匹配的详细信息
  const matchingTolerance = options.binSize * 2;
  const bestMatches = matchDetails.filter(match => 
    Math.abs(match.offset - bestOffset) <= matchingTolerance
  );
  
  // 计算匹配率和置信度
  const matchCount = bestMatches.length;
  const matchRate = matchCount / fingerprintsA.length;
  const confidence = maxCount;
  
  // 简化返回的匹配详情
  const simplifiedMatches = bestMatches.map(match => ({
    hashA: match.hashA,
    timeA: match.timeA,
    timeB: match.timeB
  }));
  
  return {
    offset: bestOffset,
    matchCount,
    matchRate,
    confidence,
    matches: simplifiedMatches
  };
}

/**
 * 格式化时间
 */
function formatTime(seconds: number): string {
    const hour = Math.floor(seconds / 3600);
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const msecs = Math.floor(seconds % 1000);
    return `${hour}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${msecs.toString().padStart(3, '0')}`;
}

(async () => {
  try {
    console.log("正在生成音频指纹...");
    
    // 获取两个音频文件的指纹
    const fingerprintsA = await getFingerprints(path.resolve(__dirname, "../simple/音乐.flac"));
    const fingerprintsB = await getFingerprints(path.resolve(__dirname, "../simple/录音.m4a"));
    
    console.log(`音频A指纹数量: ${fingerprintsA.length}`);
    console.log(`音频B指纹数量: ${fingerprintsB.length}`);
    
    // 保存指纹到文件（可选）
    const outputDir = path.resolve(__dirname, "../output");
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    fs.writeFileSync(
      path.resolve(outputDir, "fingerprintsA.json"), 
      JSON.stringify(fingerprintsA, null, 2)
    );
    
    fs.writeFileSync(
      path.resolve(outputDir, "fingerprintsB.json"), 
      JSON.stringify(fingerprintsB, null, 2)
    );
    
    // 查找音频A在音频B中的位置
    console.log("正在分析音频匹配位置...");
    const result = findAudioPosition(fingerprintsA, fingerprintsB);
    
    console.log("\n====== 匹配结果 ======");
    console.log(`音频A在音频B中的开始位置: ${result.offset/1000}秒 (${formatTime(result.offset/1000)})`);
    console.log(`匹配的指纹数量: ${result.matchCount}/${fingerprintsA.length}`);
    console.log(`匹配率: ${(result.matchRate * 100).toFixed(2)}%`);
    console.log(`置信度: ${result.confidence}`);
    
    if (result.confidence < 5) {
      console.log("警告: 置信度较低，匹配结果可能不准确");
    }
    
    // 保存匹配结果
    fs.writeFileSync(
      path.resolve(outputDir, "matchResult.json"), 
      JSON.stringify(result, null, 2)
    );
    
    console.log("\n详细匹配信息已保存到 output/matchResult.json");
    
  } catch (error) {
    console.error("处理过程中出错:", error);
  }
})();
