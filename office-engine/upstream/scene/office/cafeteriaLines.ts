// 本文件为原版休息区提供四语对话，语义键在每个员工说话时解析。
import { speechToken } from '../../../speech';
import type { OfficeCharacterName } from './cast';
export type BreakSpot = 'coffee' | 'vending' | 'snack' | 'table';
type Exchange = readonly string[];
// pickSoloLine 按休息地点选取闲聊台词。
export function pickSoloLine(character: OfficeCharacterName, spot: BreakSpot, seed: number): string {
  return speechToken(`solo.${spot}.${Math.abs(seed) % (spot === 'coffee' ? 3 : 2)}`);
}
// pickExchange 返回双方交替说出的台词，支持不同母语的员工对话。
export function pickExchange(speaker: OfficeCharacterName, seed: number): Exchange {
  const index = Math.abs(seed) % 2;
  return Array.from({ length: index === 0 ? 4 : 2 }, (_, beat) => speechToken(`pair.${index}.${beat}`));
}
