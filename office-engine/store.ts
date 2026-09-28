// 本文件将上游场景订阅接口适配到 GoalHub 快照，不创建虚构的 Agent 或任务。
import { useSyncExternalStore } from 'react';

export type Agent = { id: string; language?: string; character: string; isGod: boolean; accent: string; status: string; action: string; carrying: string; lastPrompt: string };
type State = { agents: Agent[]; selectedId: string; officeTheme: string; fullscreenAgentId: string | null; ideOpen: boolean; select: (id: string) => void; requestCommandCenterTab: (name: string) => void };
const listeners = new Set<(state: State, previous: State) => void>();
let state: State = { agents: [], selectedId: 'developer', officeTheme: 'office', fullscreenAgentId: null, ideOpen: false, select() {}, requestCommandCenterTab() {} };

// setState 发布新快照，并向原场景提供前后状态用于增量同步。
export function setState(value: Partial<State>) { const previous = state; state = { ...state, ...value }; listeners.forEach(listener => listener(state, previous)); }
// subscribe 注册订阅，卸载时移除，避免项目切换残留监听。
function subscribe(listener: (state: State, previous: State) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
// useStore 保持上游使用的 Hook、getState 和 subscribe 契约。
export const useStore = Object.assign(function useStore<T>(selector: (state: State) => T) { return useSyncExternalStore(subscribe, () => selector(state)); }, { getState: () => state, subscribe });
