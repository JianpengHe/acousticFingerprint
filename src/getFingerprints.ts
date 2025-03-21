import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { Codegen, SAMPLING_RATE, STEP } from "./Codegen";
// 保存指纹到文件（可选）
// 这对于调试和分析很有用
const outputDir = path.resolve(__dirname, "../output");
fs.mkdir(outputDir, { recursive: true }, () => {});
// 配置路径
const ffmpegPath = path.resolve(__dirname, "../../ffmpeg.exe");

// 检查文件是否存在
if (!fs.existsSync(ffmpegPath)) {
  console.error("错误: FFmpeg可执行文件不存在!");
  process.exit(1);
}

type Fingerprint = { time: number; hash: number };
export function getFingerprints(audioFilePath: string) {
  return new Promise<Fingerprint[]>((resolve, reject) => {
    fs.readFile(audioFilePath + ".fingerprints.json", (err, data) => {
      if (err === null && data) {
        console.log(`从缓存文件读取指纹数据`);
        resolve(JSON.parse(data.toString()));
        return;
      }

      // console.log('FFmpeg路径:', ffmpegPath);
      // console.log('音频文件路径:', audioFilePath);

      if (!fs.existsSync(audioFilePath)) {
        console.error("错误: 音频文件不存在!");
        process.exit(1);
      }

      // 创建ffmpeg进程来解码音频
      const decoder = spawn(
        ffmpegPath,
        [
          "-i",
          audioFilePath,
          "-acodec",
          "pcm_s16le",
          "-ar",
          SAMPLING_RATE.toString(),
          "-ac",
          "1",
          "-f",
          "wav",
          "-v",
          "fatal",
          "pipe:1",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );

      // 创建指纹生成器
      const fingerprinter = new Codegen();

      // 将ffmpeg解码器的输出连接到指纹生成器
      decoder.stdout.pipe(fingerprinter);

      // 存储所有指纹
      const fingerprints: Fingerprint[] = [];

      // 监听指纹数据
      fingerprinter.on("data", data => {
        for (let i = 0; i < data.tcodes.length; i++) {
          fingerprints.push({
            time: data.tcodes[i] * (STEP / SAMPLING_RATE) * 1000,
            hash: data.hcodes[i],
          });
        }
      });

      // 处理完成
      fingerprinter.on("end", () => {
        // 保存指纹到文件
        fs.writeFile(audioFilePath + ".fingerprints.json", JSON.stringify(fingerprints), () => {});
        console.log(`指纹数据已保存`);
        resolve(fingerprints);
      });

      // 处理错误
      decoder.stderr.on("data", data => {
        console.error(`FFmpeg错误: ${data}`);
        reject(new Error(`FFmpeg错误: ${data}`));
      });

      decoder.on("error", error => {
        console.error(`解码器错误: ${error.message}`);
        reject(new Error(`解码器错误: ${error.message}`));
      });

      fingerprinter.on("error", error => {
        console.error(`指纹生成器错误: ${error.message}`);
        reject(new Error(`指纹生成器错误: ${error.message}`));
      });
    });
  });
}
