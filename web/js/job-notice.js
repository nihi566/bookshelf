// 分析が終わったときの通知（NIH-227）。DOM に触れず、toast と go を受け取って呼ぶだけなので Node から確かめられる
import { JOB_PATHS } from './routes.js';

// 理由を読んで押し直せるよう、ふつうの通知（2.6 秒）より長く出す
const FAILURE_TOAST_MS = 10000;

/**
 * 走っていた分析が失敗・中断で止まったら、知識の画面（JOB_PATHS）以外にいても気づけるよう通知する。
 * 知識の画面では分析の欄に理由が出るので通知しない。成功・状況不明（lost）・自分で中止した分析（cancelling）は通知しない。
 * PC のサーバが再起動したときは「初期状態に戻った job（止まっただけ）」→「中断」の 2 段で届くので、中断は stage が変わった時点で知らせる
 * @param {{ prev?: object, job: object, path: string, toast: Function, go: (hash: string) => unknown }} p
 */
export function notifyJobEnd({ prev, job, path, toast, go }) {
  if (!prev || job.running || job.lost || job.cancelling) return;
  if (JOB_PATHS.includes(path)) return;
  const interrupted = job.stage === 'interrupted';
  if (interrupted ? prev.stage === 'interrupted' : !prev.running || (job.stage !== 'error' && !job.error)) return;
  const head = interrupted ? '分析が中断しました' : '分析が失敗しました';
  toast(job.error ? `${head}: ${job.error}` : head, FAILURE_TOAST_MS, { label: '知識の画面へ', run: () => go('#/knowledge') });
}
