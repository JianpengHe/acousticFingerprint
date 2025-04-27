/**
 * 声音指纹生成模块 (Codegen.ts)
 *
 * 本模块实现了基于地标(landmark)的音频指纹算法，是整个声音指纹匹配系统的核心组件。
 * 算法基于D. Ellis (2009)的"Robust Landmark-Based Audio Fingerprinting"和Wang 2003论文的思想。
 *
 * 工作原理：
 * 1. 对输入的音频信号进行分帧处理
 * 2. 对每一帧应用快速傅里叶变换(FFT)得到频谱
 * 3. 在频谱中检测局部最大值(峰值)
 * 4. 将峰值配对形成"地标对"(landmark pairs)
 * 5. 根据地标对生成哈希值作为声音指纹
 *
 * 这些指纹具有抗噪声、抗失真的特性，可用于音频识别和匹配。
 */

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Copyright (c) 2018 Alexandre Storelli

// Online implementation of the landmark audio fingerprinting algorithm.
// inspired by D. Ellis (2009), "Robust Landmark-Based Audio Fingerprinting"
// http://labrosa.ee.columbia.edu/matlab/fingerprint/
// itself inspired by Wang 2003 paper

// This module exports Codegen, an instance of stream.Transform
// By default, the writable side must be fed with an input signal with the following properties:
// - single channel
// - 16bit PCM
// - 44100 Hz sampling rate
//
// The readable side outputs objects of the form
// { tcodes: [time stamps], hcodes: [fingerprints] }

import { Transform } from "stream";
import * as dsp from "dsp.js";

const log = console.log;

/**
 * 采样率(Hz)
 * 音频处理的基本参数，决定了可以分析的最高频率(奈奎斯特频率 = SAMPLING_RATE/2)
 * 44100Hz是CD音质的标准采样率，可以表示高达22050Hz的频率
 */
export const SAMPLING_RATE = 44100;
// sampling rate in Hz. If you change this, you must adapt WINDOW_DT and PRUNING_DT below to match your needs
// set the Nyquist frequency, SAMPLING_RATE/2, so as to match the max frequencies you want to get landmark fingerprints.

/**
 * 每个样本的字节数
 * BPS=2表示16位PCM音频(2字节=16位)
 */
const BPS = 2;
// bytes per sample, 2 for 16 bit PCM. If you change this, you must change readInt16LE methods in the code.

/**
 * 每个频谱的最大局部最大值数量
 * 控制每一帧中保留的峰值数量，增加此值可以生成更多指纹
 * 从5增加到10，显著增加了生成的指纹数量，提高了匹配精度
 */
const MNLM = 10; // 从5增加到10，每个频谱的最大局部最大值数量。增加此值可以生成更多指纹
// maximum number of local maxima for each spectrum. useful to tune the amount of fingerprints at output

/**
 * 每个峰值可以生成的哈希数量上限
 * 控制每个峰值最多可以与多少个历史峰值配对形成指纹
 * 从3增加到10，大幅增加了指纹数量，提高了匹配的鲁棒性
 */
const MPPP = 10; // 从3增加到10，每个峰值可以生成的哈希数量上限。增加此值可以生成更多指纹
// maximum of hashes each peak can lead to. useful to tune the amount of fingerprints at output

/**
 * FFT窗口大小
 * 决定了频率分辨率和时间分辨率之间的平衡
 * 较大的NFFT提供更好的频率分辨率，但时间分辨率降低
 */
const NFFT = 64; // size of the FFT window. As we use real signals, the spectra will have nfft/2 points.
// Increasing it will give more spectral precision, less temporal precision.
// It may be good or bad depending on the sounds you want to match and on whether your input is deformed by EQ or noise.

/**
 * 帧移步长，采用50%重叠
 * 重叠的帧可以提供更平滑的时间分析，捕获更多的音频特征
 */
export const STEP = NFFT / 2; // 50 % overlap
// if SAMPLING_RATE is 44100 Hz, this leads to a sampling frequency
// fs = (SAMPLING_RATE / STEP) /s = 86/s, or dt = 1/fs = 11,61 ms.
// It's not really useful to change the overlap ratio.

/**
 * 时间分辨率，表示相邻帧之间的时间间隔(秒)
 * 在44100Hz采样率下，约为11.61毫秒
 */
const DT = 1 / (SAMPLING_RATE / STEP);

/**
 * FFT处理器实例
 * 用于计算音频帧的频谱
 */
const FFT = new dsp.FFT(NFFT, SAMPLING_RATE);

/**
 * 汉宁窗函数
 * 应用于每个音频帧以减少频谱泄漏，提高频谱分析的准确性
 * 窗函数可以平滑信号在帧边界的不连续性
 */
const HWIN = new Array(NFFT); // prepare the hann window
for (var i = 0; i < NFFT; i++) {
  HWIN[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (NFFT - 1)));
}

/**
 * 阈值衰减因子的对数值
 * 控制峰值检测阈值随时间的衰减速率
 * 从0.995改为0.99，使阈值衰减更快，从而保留更多的峰值
 */
const MASK_DECAY_LOG = Math.log(0.99); // 从0.995改为0.99，使阈值衰减更快，从而保留更多的峰值
// threshold decay factor between frames.

/**
 * 频率窗口的最小值和最大值
 * 定义了用于生成指纹的频率范围
 * IF_MIN=0包含所有低频成分，IF_MAX=NFFT/2包含所有高频成分
 */
// frequency window to generate landmark pairs, in units of DF = SAMPLING_RATE / NFFT. Values between 0 and NFFT/2
const IF_MIN = 0; // 保持为0，以包含所有低频成分
// you can increase this to avoid having fingerprints for low frequencies
const IF_MAX = NFFT / 2; // 保持最大值，包含所有高频成分
// you don't really want to decrease this, better reduce SAMPLING_RATE instead for faster computation.

/**
 * 频率窗口范围
 * 限制配对峰值之间的最大频率差异
 * 从60增加到80，允许更大的频率差异，从而生成更多的指纹对
 */
const WINDOW_DF = 80; // 从60增加到80，允许更大的频率差异，从而生成更多的指纹对
// we set this to avoid getting fingerprints linking very different frequencies.
// useful to reduce the amount of fingerprints. this can be maxed at NFFT/2 if you wish.

/**
 * 生成地标对的时间窗口
 * 控制当前峰值可以与多远过去的峰值配对
 * 从96增加到120，允许更长的时间窗口，生成更多指纹
 */
// time window to generate landmark pairs. time in units of dt (see definition above)
const WINDOW_DT = 120; // 从96增加到120，生成地标对的时间窗口。增加此值可以让每个峰值与更多历史峰值配对
// a little more than 1 sec.

/**
 * 移除先前峰值的窗口
 * 控制峰值剪枝的时间窗口，也影响算法的延迟
 * 从24增加到32，以适应更快的阈值衰减
 */
const PRUNING_DT = 32; // 从24增加到32，以适应更快的阈值衰减，确保有足够的时间窗口来处理更多的峰值
// about 250 ms, window to remove previous peaks that are superseded by later ones.
// tune the PRUNING_DT value to match the effects of MASK_DECAY_LOG.
// also, PRUNING_DT controls the latency of the pipeline. higher PRUNING_DT = higher latency

/**
 * 掩码衰减尺度
 * 控制频率轴上的高斯掩码宽度
 */
// prepare the values of exponential masks.
const MASK_DF = 3; // mask decay scale in DF units on the frequency axis.

/**
 * 指数加权窗口(EWW)
 * 用于计算频谱阈值的高斯掩码矩阵
 * 对于每个频率点，定义了一个衰减曲线，用于抑制周围的较小峰值
 * 高频区域的掩码更宽，低频区域的掩码更窄
 */
const EWW = new Array(NFFT / 2);
for (let i = 0; i < NFFT / 2; i++) {
  EWW[i] = new Array(NFFT / 2);
  for (let j = 0; j < NFFT / 2; j++) {
    EWW[i][j] = -0.5 * Math.pow((j - i) / MASK_DF / Math.sqrt(i + 3), 2); // gaussian mask is a polynom when working on the log-spectrum. log(exp()) = Id()
    // MASK_DF is multiplied by Math.sqrt(i+3) to have wider masks at higher frequencies
    // see the visualization out-thr.png for better insight of what is happening
  }
}

/**
 * 详细日志输出开关
 * 设置为true时会输出更多调试信息
 */
const VERBOSE = false;

/**
 * Codegen选项接口
 * 定义了创建Codegen实例时可以传入的配置选项
 */
interface Options {
  readableObjectMode: true; // 启用对象模式输出
  highWaterMark: number; // 缓冲区大小控制
}

/**
 * 标记接口
 * 表示频谱中的峰值信息
 * @property t - 时间索引
 * @property i - 频率索引数组
 * @property v - 峰值幅度数组
 */
interface Mark {
  t: number; // 时间索引
  i: number[]; // 频率索引数组
  v: number[]; // 峰值幅度数组
}

/**
 * Codegen类 - 声音指纹生成器
 * 继承自Transform流，可以处理流式音频数据
 * 将输入的音频数据转换为声音指纹
 */
export class Codegen extends Transform {
  /** 音频数据缓冲区 */
  buffer: Buffer;
  /** 缓冲区偏移量，用于处理大型音频流 */
  bufferDelta: number;
  /** 当前处理的样本索引 */
  stepIndex: number;
  /** 存储所有时间帧的峰值标记 */
  marks: Mark[];
  /** 频谱阈值，用于峰值检测 */
  threshold: any[];
  /** 时间分辨率(秒) */
  DT: number;
  /** 采样率(Hz) */
  SAMPLING_RATE: number;
  /** 每个样本的字节数 */
  BPS: number;

  /**
   * 构造函数
   * @param options - Codegen配置选项
   */
  constructor(options: Partial<Options> = {}) {
    super({
      readableObjectMode: true,
      highWaterMark: 10,
      ...options,
    });
    // 初始化音频缓冲区
    this.buffer = Buffer.alloc(0);
    this.bufferDelta = 0;

    // 初始化处理状态
    this.stepIndex = 0;
    this.marks = [];

    // 初始化频谱阈值数组
    this.threshold = new Array(NFFT / 2);
    for (let i = 0; i < NFFT / 2; i++) {
      this.threshold[i] = -3; // 初始阈值设为-3
    }

    // 复制常量以便在父模块中引用
    this.DT = DT;
    this.SAMPLING_RATE = SAMPLING_RATE;
    this.BPS = BPS;
  }

  /**
   * 处理输入的音频数据块
   * Transform流的核心方法，实现了声音指纹生成算法
   * @param chunk - 输入的音频数据块
   * @param _ - 编码(未使用)
   * @param next - 回调函数，处理完成后调用
   */
  _write(chunk: Buffer, _: any, next: Function) {
    if (VERBOSE) {
      log(`t=${Math.round(this.stepIndex / STEP)} received ${chunk.length} bytes`);
    }

    // 存储生成的时间码和哈希码
    let tcodes: number[] = [];
    let hcodes: number[] = [];

    // 将新的数据块添加到缓冲区
    this.buffer = Buffer.concat([this.buffer, chunk]);

    // 当缓冲区中有足够的数据时，处理音频帧
    while ((this.stepIndex + NFFT) * BPS < this.buffer.length + this.bufferDelta) {
      // 创建音频帧数据数组
      let data = new Array(NFFT); // window data

      // 填充数据，应用汉宁窗并缩放
      for (let i = 0, limit = NFFT; i < limit; i++) {
        data[i] =
          (HWIN[i] * this.buffer.readInt16LE((this.stepIndex + i) * BPS - this.bufferDelta)) / Math.pow(2, 8 * BPS - 1);
      }
      // 移动到下一帧(50%重叠)
      this.stepIndex += STEP;

      // 计算FFT得到频谱
      FFT.forward(data); // compute FFT

      // 应用对数正态曲面增强
      // 低频部分被抑制，高频部分被增强，有助于更好地检测峰值
      for (let i = IF_MIN; i < IF_MAX; i++) {
        // the lower part of the spectrum is damped, the higher part is boosted, leading to a better peaks detection.
        FFT.spectrum[i] = Math.abs(FFT.spectrum[i]) * Math.sqrt(i + 16);
      }

      // 计算对数频谱与阈值的差值(仅保留正值)
      // 这些差值用于检测局部最大值
      let diff = new Array(NFFT / 2);
      for (let i = IF_MIN; i < IF_MAX; i++) {
        diff[i] = Math.max(Math.log(Math.max(1e-6, FFT.spectrum[i])) - this.threshold[i], 0);
      }

      // 在当前时间戳找出最多MNLM个局部最大值(峰值)
      // 初始化局部最大值数组
      let iLocMax = new Array(MNLM); // 存储频率索引
      let vLocMax = new Array(MNLM); // 存储幅度值
      for (let i = 0; i < MNLM; i++) {
        iLocMax[i] = NaN;
        vLocMax[i] = Number.NEGATIVE_INFINITY;
      }

      // 扫描频谱寻找局部最大值
      for (let i = IF_MIN + 1; i < IF_MAX - 1; i++) {
        // 检查是否为局部最大值：比左右邻居大，且足够大以进入排序列表
        if (diff[i] > diff[i - 1] && diff[i] > diff[i + 1] && FFT.spectrum[i] > vLocMax[MNLM - 1]) {
          // 将新发现的局部最大值插入有序列表
          for (let j = MNLM - 1; j >= 0; j--) {
            // 导航已保存最大值的表格
            if (j >= 1 && FFT.spectrum[i] > vLocMax[j - 1]) continue;
            for (let k = MNLM - 1; k >= j + 1; k--) {
              iLocMax[k] = iLocMax[k - 1]; // offset the bottom values
              vLocMax[k] = vLocMax[k - 1];
            }
            // 插入新的局部最大值
            iLocMax[j] = i;
            vLocMax[j] = FFT.spectrum[i];
            break;
          }
        }
      }

      // 根据找到的MNLM个最高局部最大值，更新局部最大值阈值
      // 这确保只有主要峰值被考虑
      for (let i = 0; i < MNLM; i++) {
        if (vLocMax[i] > Number.NEGATIVE_INFINITY) {
          // 应用高斯掩码更新阈值
          for (let j = IF_MIN; j < IF_MAX; j++) {
            this.threshold[j] = Math.max(this.threshold[j], Math.log(FFT.spectrum[iLocMax[i]]) + EWW[iLocMax[i]][j]);
          }
        } else {
          // 如果没有足够的局部最大值，移除剩余元素
          vLocMax.splice(i, MNLM - i); // remove the last elements.
          iLocMax.splice(i, MNLM - i);
          break;
        }
      }

      // 将当前时间步的局部最大值存储到标记数组
      this.marks.push({
        t: Math.round(this.stepIndex / STEP),
        i: iLocMax,
        v: vLocMax,
      });

      // 移除之前(时间上)太接近和/或太低的最大值
      // 这是峰值剪枝过程，确保只保留显著的峰值
      let nm = this.marks.length;
      let t0 = nm - PRUNING_DT - 1;
      for (let i = nm - 1; i >= Math.max(t0 + 1, 0); i--) {
        for (let j = 0; j < this.marks[i].v.length; j++) {
          // 检查峰值是否低于衰减阈值
          if (
            this.marks[i].i[j] != 0 &&
            Math.log(this.marks[i].v[j]) < this.threshold[this.marks[i].i[j]] + MASK_DECAY_LOG * (nm - 1 - i)
          ) {
            // 将不符合条件的峰值标记为无效
            this.marks[i].v[j] = Number.NEGATIVE_INFINITY;
            this.marks[i].i[j] = Number.NEGATIVE_INFINITY;
          }
        }
      }

      // 为不再能被剪枝的峰值生成哈希值
      // 这是指纹生成的核心步骤：将当前峰值与历史峰值配对形成地标对
      let nFingersTotal = 0;
      if (t0 >= 0) {
        // 获取当前时间窗口的标记
        let m = this.marks[t0];

        // 遍历当前时间窗口的所有峰值
        loopCurrentPeaks: for (let i = 0; i < m.i.length; i++) {
          let nFingers = 0;

          // 遍历过去的时间窗口
          loopPastTime: for (let j = t0; j >= Math.max(0, t0 - WINDOW_DT); j--) {
            let m2 = this.marks[j];

            // 遍历过去时间窗口的所有峰值
            loopPastPeaks: for (let k = 0; k < m2.i.length; k++) {
              // 检查峰值对是否满足配对条件：不同频率且频率差在窗口范围内
              if (m2.i[k] != m.i[i] && Math.abs(m2.i[k] - m.i[i]) < WINDOW_DF) {
                // 添加时间码(当前峰值的时间索引)
                tcodes.push(m.t);

                // 生成哈希码：编码频率对和时间差
                // 哈希结构: f1 + (NFFT/2) * (f2 + (NFFT/2) * dt)
                // 其中：
                // - f1是过去峰值的频率索引(m2.i[k])
                // - f2是当前峰值的频率索引(m.i[i])
                // - dt是时间差(t0-j)
                hcodes.push(m2.i[k] + (NFFT / 2) * (m.i[i] + (NFFT / 2) * (t0 - j)));

                // 增加指纹计数
                nFingers += 1;
                nFingersTotal += 1;

                // 如果当前峰值已生成足够多的指纹，继续处理下一个峰值
                if (nFingers >= MPPP) continue loopCurrentPeaks;
              }
            }
          }
        }
      }

      // 输出生成的指纹数量(如果启用详细日志)
      if (nFingersTotal > 0 && VERBOSE) {
        log(`t=${Math.round(this.stepIndex / STEP)} generated ${nFingersTotal} fingerprints`);
      }

      // 移除不再需要的旧标记，保持内存使用效率
      this.marks.splice(0, t0 + 1 - WINDOW_DT);

      // 降低下一次迭代的阈值，使得随时间推移可以检测到更多峰值
      for (let j = 0; j < this.threshold.length; j++) {
        this.threshold[j] += MASK_DECAY_LOG;
      }
    }

    // 管理缓冲区大小，防止内存溢出
    // 当缓冲区过大时，移除旧数据
    if (this.buffer.length > 1000000) {
      const delta = this.buffer.length - 20000;
      this.bufferDelta += delta;
      this.buffer = this.buffer.slice(delta);
    }

    // if (VERBOSE) {
    // log("fp processed " + (this.practicalDecodedBytes - this.decodedBytesSinceCallback) + " while threshold is " + (0.99*this.thresholdBytes));
    // }

    // 如果生成了指纹，将它们推送到输出流
    if (tcodes.length > 0) {
      this.push({ tcodes, hcodes });
      // this will eventually trigger data events on the read interface
    }

    // 调用回调函数，表示处理完成
    next();
  }
}
