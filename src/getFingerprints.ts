import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { Codegen } from "./Codegen";
// 配置路径
const ffmpegPath = path.resolve(__dirname, "../../ffmpeg.exe");
type Fingerprint = { time: number; hash: number };
export function getFingerprints(audioFilePath: string) {
  return new Promise<Fingerprint[]>((resolve, reject) => {
    // console.log('FFmpeg路径:', ffmpegPath);
    // console.log('音频文件路径:', audioFilePath);

    // 检查文件是否存在
    if (!fs.existsSync(ffmpegPath)) {
      console.error("错误: FFmpeg可执行文件不存在!");
      process.exit(1);
    }

    if (!fs.existsSync(audioFilePath)) {
      console.error("错误: 音频文件不存在!");
      process.exit(1);
    }

    // 创建ffmpeg进程来解码音频
    const decoder = spawn(
      ffmpegPath,
      ["-i", audioFilePath, "-acodec", "pcm_s16le", "-ar", "22050", "-ac", "1", "-f", "wav", "-v", "fatal", "pipe:1"],
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
          time: data.tcodes[i] * 10,
          hash: data.hcodes[i],
        });
        // console.log(`时间=${data.tcodes[i]} 指纹=${data.hcodes[i]}`);
      }
    });

    // 处理完成
    fingerprinter.on("end", () => {
      //   console.log('指纹生成完成!');
      //   console.log(`共生成 ${fingerprints.length} 个指纹`);

      // 保存指纹到文件
      //   const outputPath = path.resolve(__dirname, '../output/fingerprints.json');

      //   // 确保输出目录存在
      //   const outputDir = path.dirname(outputPath);
      //   if (!fs.existsSync(outputDir)) {
      //     fs.mkdirSync(outputDir, { recursive: true });
      //   }

      //   fs.writeFileSync(outputPath, JSON.stringify(fingerprints, null, 2));
      //   console.log(`指纹数据已保存到: ${outputPath}`);
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
}
