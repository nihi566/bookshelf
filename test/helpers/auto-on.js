// 自動の分析は既定で切ってある（NIH-307）。自動の分析の判断を試すテストは、入れた設定で呼ぶ（config で切れば切れる）
import { autoAnalyzeDue as due } from '../../web/core/auto-analysis.js';

export const autoAnalyzeDue = (args) => due({ ...args, config: { enabled: true, ...args.config } });

// bh serve を動かすテストの config.json に入れる自動の分析の設定
export const AUTO_ON = { enabled: true };
