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
 * @param options 配置选项，包括置信度阈值、时间分箱大小、采样率和提前终止阈值
 * @returns 匹配结果对象
 */
export function findAudioPosition(
  fingerprintsA: Fingerprint[],
  fingerprintsB: Fingerprint[],
  options = {
    confidenceThreshold: 5,
    binSize: 0.05,
    sampleRate: 1.0, // 采样率，1.0表示使用所有指纹，0.5表示使用一半指纹
    earlyStopThreshold: 0.8, // 当某个偏移的匹配数达到指纹A总数的这个比例时提前终止
    maxMatchesToReturn: 100, // 最多返回的匹配详情数量
  },
): MatchResult {
  console.time("构建哈希表");

  // 优化1: 对大数据集进行采样，减少处理量
  let fingerprintsASampled = fingerprintsA;
  if (options.sampleRate < 1.0) {
    // 只对A进行采样，B保持完整以确保不错过匹配
    fingerprintsASampled = fingerprintsA.filter(() => Math.random() < options.sampleRate);
    console.log(`采样后的指纹A数量: ${fingerprintsASampled.length}/${fingerprintsA.length}`);
  }

  // 创建哈希表以加速查找
  const hashMapB = new Map<number, number[]>();

  // 优化2: 使用Set临时存储已处理的哈希值，避免重复检查
  //   const processedHashes = new Set<number>();

  // 为音频B的每个哈希值建立索引
  for (const fp of fingerprintsB) {
    if (!hashMapB.has(fp.hash)) {
      hashMapB.set(fp.hash, []);
    }
    hashMapB.get(fp.hash)!.push(fp.time);
  }

  console.timeEnd("构建哈希表");
  console.time("查找匹配");

  // 优化3: 使用Map代替对象存储偏移箱，提高查找和更新效率
  const offsetBins = new Map<number, number>();

  // 优化4: 不存储所有匹配详情，而是只保留最佳偏移的匹配
  // 使用Map跟踪每个偏移值的前N个匹配详情
  const topMatchesByOffset = new Map<number, Array<{ hashA: number; timeA: number; timeB: number }>>();

  // 提前终止的阈值
  const earlyStopCount = Math.floor(fingerprintsASampled.length * options.earlyStopThreshold);
  let bestOffset = 0;
  let maxCount = 0;

  // 对每个指纹A查找匹配的指纹B
  for (const fingerprint of fingerprintsASampled) {
    // 查找与当前音频A指纹具有相同哈希值的所有音频B指纹
    const matchingTimesB = hashMapB.get(fingerprint.hash);

    if (matchingTimesB) {
      // 对于每个匹配的时间点，计算时间偏移
      for (const timeB of matchingTimesB) {
        // 计算偏移：音频B的时间 - 音频A的时间
        const offset = timeB - fingerprint.time;

        // 将偏移量分箱以处理微小的时间差异
        const binKey = Math.round(offset / options.binSize) * options.binSize;

        // 更新偏移箱计数
        const currentCount = (offsetBins.get(binKey) || 0) + 1;
        offsetBins.set(binKey, currentCount);

        // 更新最佳偏移
        if (currentCount > maxCount) {
          maxCount = currentCount;
          bestOffset = binKey;

          // 优化5: 当某个偏移的匹配数达到阈值时提前终止
          if (maxCount >= earlyStopCount) {
            console.log(`提前终止搜索，已找到足够的匹配: ${maxCount}/${fingerprintsASampled.length}`);
            break;
          }
        }

        // 为最佳候选偏移保存匹配详情
        // 只为每个偏移值保存有限数量的匹配详情
        if (currentCount > fingerprintsASampled.length * 0.1) {
          // 只为有希望的偏移值保存详情
          if (!topMatchesByOffset.has(binKey)) {
            topMatchesByOffset.set(binKey, []);
          }

          const matches = topMatchesByOffset.get(binKey)!;
          if (matches.length < options.maxMatchesToReturn) {
            matches.push({
              hashA: fingerprint.hash,
              timeA: fingerprint.time,
              timeB: timeB,
            });
          }
        }
      }

      // 如果已经找到足够的匹配，提前终止外层循环
      if (maxCount >= earlyStopCount) {
        break;
      }
    }
  }

  console.timeEnd("查找匹配");
  console.time("处理结果");

  // 获取最佳偏移的匹配详情
  const bestMatches = topMatchesByOffset.get(bestOffset) || [];

  // 如果没有足够的最佳偏移匹配详情，尝试收集接近最佳偏移的匹配
  if (bestMatches.length < Math.min(maxCount, options.maxMatchesToReturn)) {
    const matchingTolerance = options.binSize * 2;

    // 查找接近最佳偏移的其他偏移值
    for (const [offset, matches] of topMatchesByOffset.entries()) {
      if (offset !== bestOffset && Math.abs(offset - bestOffset) <= matchingTolerance) {
        // 添加接近的偏移值的匹配，直到达到所需数量
        for (const match of matches) {
          bestMatches.push(match);
          if (bestMatches.length >= options.maxMatchesToReturn) {
            break;
          }
        }
      }

      if (bestMatches.length >= options.maxMatchesToReturn) {
        break;
      }
    }
  }

  // 计算匹配率和置信度
  const matchCount = maxCount;
  const matchRate = matchCount / fingerprintsASampled.length;
  // 如果进行了采样，调整匹配率计算
  const adjustedMatchRate =
    options.sampleRate < 1.0 ? matchCount / (fingerprintsASampled.length / options.sampleRate) : matchRate;

  const confidence = maxCount;

  console.timeEnd("处理结果");

  // 返回完整的匹配结果
  return {
    offset: bestOffset, // 最佳偏移值（毫秒）
    matchCount, // 匹配的指纹数量
    matchRate: adjustedMatchRate, // 调整后的匹配率
    confidence, // 置信度
    matches: bestMatches.slice(0, options.maxMatchesToReturn), // 限制返回的匹配详情数量
  };
}
