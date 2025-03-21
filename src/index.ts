/**
 * 声音指纹匹配系统 - 主程序
 *
 * 本文件实现了基于声音指纹的音频匹配算法，可以用于识别一段音频在另一段音频中的位置。
 * 算法基于哈希匹配和时间对齐的原理，通过比较两段音频的指纹特征来确定它们的相对位置关系。
 *
 * 工作流程：
 * 1. 从两个音频文件中提取声音指纹
 * 2. 构建哈希表以加速匹配过程
 * 3. 计算时间偏移并进行统计分析
 * 4. 确定最佳匹配位置并计算置信度
 */
import path = require("path");
import { getFingerprints } from "./getFingerprints";
import { findAudioPosition } from "./findAudioPosition";

/**
 * 主程序入口
 * 执行音频指纹提取和匹配的完整流程
 */
(async () => {
  console.time("耗时");
  try {
    console.log("正在生成音频指纹...");

    // 获取两个音频文件的指纹
    // 音频A：通常是较短的查询音频
    const fingerprintsA = await getFingerprints(path.resolve(__dirname, "../simple/音乐.flac"));
    console.log(`音频A指纹数量: ${fingerprintsA.length}`);
    // 音频B：通常是较长的参考音频
    // const fingerprintsB = await getFingerprints(path.resolve(__dirname, "../simple/录音.m4a"));
    const fingerprintsB = await getFingerprints(path.resolve(__dirname, "../simple/L.flac"));
    console.log(`音频B指纹数量: ${fingerprintsB.length}`);

    // 查找音频A在音频B中的位置
    console.log("正在分析音频匹配位置...");
    const result = findAudioPosition(fingerprintsA, fingerprintsB);

    // 输出匹配结果
    console.log("\n====== 匹配结果 ======");
    // 将偏移值从毫秒转换为秒，并格式化显示
    console.log(`音频A在音频B中的开始位置: ${result.offset / 1000}秒 (${formatTime(result.offset / 1000)})`);
    console.log(`匹配的指纹数量: ${result.matchCount}/${fingerprintsA.length}`);
    console.log(`匹配率: ${(result.matchRate * 100).toFixed(2)}%`);
    console.log(`置信度: ${result.confidence}`);

    // 置信度检查
    // 如果置信度低于阈值，警告用户结果可能不准确
    if (result.confidence < 5) {
      console.log("警告: 置信度较低，匹配结果可能不准确");
    }
  } catch (error) {
    console.error("处理过程中出错:", error);
  }
  console.timeEnd("耗时");
})();

/**
 * 格式化时间
 * 将秒数转换为人类可读的时间格式：小时:分钟:秒.毫秒
 * @param seconds 秒数
 * @returns 格式化后的时间字符串
 */
function formatTime(seconds: number): string {
  const hour = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds / 60) % 60);
  const secs = Math.floor(seconds % 60);
  const msecs = Math.floor((seconds * 1000) % 1000);
  return `${hour}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}.${msecs.toString().padStart(3, "0")}`;
}

// mkvmerge -o output.mkv --split parts:0-3,6-9 input.mkv
// mkvmerge -o final_output.mkv output-001.mkv + output-002.mkv
