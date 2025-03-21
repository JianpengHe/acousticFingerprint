/**
 * 查找音频A在音频B中的位置
 * @param fingerprintsA 音频A的指纹（通常是较短的查询音频）
 * @param fingerprintsB 音频B的指纹（通常是较长的参考音频）
 * @param options 配置选项
 * @returns 匹配结果
 */
interface Fingerprint {
  time: number; // 指纹在音频中的时间位置（毫秒）
  hash: number; // 指纹哈希值，由频率特征生成
}

interface MatchResult {
  offset: number; // 音频A在音频B中的开始时间（毫秒）
  matchCount: number; // 匹配的指纹数量
  matchRate: number; // 匹配率（匹配指纹数量/音频A总指纹数量）
  confidence: number; // 置信度（最佳偏移的匹配数量）
  matches: Array<{
    // 匹配的详细信息
    hashA: number; // 音频A中匹配的指纹哈希值
    timeA: number; // 指纹在音频A中的时间
    timeB: number; // 对应指纹在音频B中的时间
  }>;
}

/**
 * 查找音频A在音频B中的位置
 *
 * 算法原理：
 * 1. 为音频B的所有指纹建立哈希表，加速查找过程
 * 2. 对音频A的每个指纹，在音频B中查找相同哈希值的指纹
 * 3. 计算每对匹配指纹之间的时间偏移（音频B时间 - 音频A时间）
 * 4. 将相似的时间偏移分组（分箱），找出出现频率最高的偏移值
 * 5. 该偏移值即为音频A在音频B中最可能的起始位置
 *
 * @param fingerprintsA 音频A的指纹集合
 * @param fingerprintsB 音频B的指纹集合
 * @param options 配置选项，包括置信度阈值和时间分箱大小
 * @returns 匹配结果对象
 */
export function findAudioPosition(
  fingerprintsA: Fingerprint[],
  fingerprintsB: Fingerprint[],
  options = { confidenceThreshold: 5, binSize: 0.05 },
): MatchResult {
  // 创建哈希表以加速查找
  // 键：指纹哈希值，值：该哈希值在音频B中出现的所有时间点
  const hashMapB = new Map<number, number[]>();

  // 为音频B的每个哈希值建立索引
  // 这样可以快速找到音频A中的指纹在音频B中的所有可能匹配位置
  for (const fp of fingerprintsB) {
    if (!hashMapB.has(fp.hash)) {
      hashMapB.set(fp.hash, []);
    }
    hashMapB.get(fp.hash)!.push(fp.time);
  }

  // 存储时间偏移
  // offsetBins用于统计各个偏移值出现的次数
  const offsetBins: Record<string, number> = {};
  // matchDetails存储所有匹配的详细信息，用于后续分析
  const matchDetails: Array<{ hashA: number; timeA: number; timeB: number; offset: number }> = [];

  // 对每个指纹A查找匹配的指纹B
  for (const fpA of fingerprintsA) {
    // 查找与当前音频A指纹具有相同哈希值的所有音频B指纹
    const matchingTimesB = hashMapB.get(fpA.hash);

    if (matchingTimesB) {
      // 对于每个匹配的时间点，计算时间偏移
      for (const timeB of matchingTimesB) {
        // 计算偏移：音频B的时间 - 音频A的时间
        // 如果音频A在音频B中的某个位置开始，则所有匹配点的偏移应该接近一个固定值
        const offset = timeB - fpA.time;

        // 将偏移量分箱以处理微小的时间差异
        // 由于采样和处理误差，即使是完全匹配的音频也可能有轻微的时间偏差
        // binSize参数控制容忍的误差范围
        const binKey = Math.round(offset / options.binSize) * options.binSize;
        const binKeyStr = binKey.toString();
        // 累计每个偏移值箱的出现次数
        offsetBins[binKeyStr] = (offsetBins[binKeyStr] || 0) + 1;

        // 保存匹配详情，包括哈希值、时间点和计算的偏移
        matchDetails.push({
          hashA: fpA.hash,
          timeA: fpA.time,
          timeB: timeB,
          offset: offset,
        });
      }
    }
  }

  // 找到最频繁的偏移值
  // 出现次数最多的偏移值很可能是真实的匹配位置
  let bestOffset = 0;
  let maxCount = 0;

  for (const [offset, count] of Object.entries(offsetBins)) {
    if (count > maxCount) {
      maxCount = count;
      bestOffset = parseFloat(offset);
    }
  }

  // 筛选与最佳偏移匹配的详细信息
  // 只保留那些偏移值接近最佳偏移的匹配
  const matchingTolerance = options.binSize * 2; // 设置容忍度为分箱大小的两倍
  const bestMatches = matchDetails.filter(match => Math.abs(match.offset - bestOffset) <= matchingTolerance);

  // 计算匹配率和置信度
  // matchCount：符合最佳偏移的匹配数量
  const matchCount = bestMatches.length;
  // matchRate：匹配率，表示音频A中有多大比例的指纹在音频B中找到了匹配
  const matchRate = matchCount / fingerprintsA.length;
  // confidence：置信度，使用最佳偏移的匹配数量作为置信度指标
  const confidence = maxCount;

  // 简化返回的匹配详情
  // 只保留必要的信息，减少返回数据量
  const simplifiedMatches = bestMatches.map(match => ({
    hashA: match.hashA,
    timeA: match.timeA,
    timeB: match.timeB,
  }));

  // 返回完整的匹配结果
  return {
    offset: bestOffset, // 最佳偏移值（毫秒）
    matchCount, // 匹配的指纹数量
    matchRate, // 匹配率
    confidence, // 置信度
    matches: simplifiedMatches, // 匹配详情
  };
}
