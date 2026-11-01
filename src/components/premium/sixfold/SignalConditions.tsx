// SIXFOLD: every condition a signal must pass, with its switch and numbers. Same settings as the full page; no explanations.
import { useState } from 'react';
import type { RecoveryEntry } from './entry';
import type { RecoverySizing, SixfoldSettings } from './money';
import { Num, Seg, Switch } from './SixfoldPage';
import type { VhMode } from './virtual-hook';

type Props = { s: SixfoldSettings; set: (patch: Partial<SixfoldSettings>) => void };
type ConditionProps = Props & {
    /** The win-streak guard cannot be switched off (Sentinel AI): show its numbers without the switch. */
    streakAlwaysOn?: boolean;
};

/** Everything under the Martingale switch. */
export const MartingaleFields = ({ s, set }: Props) => (
    <div className='sn-sub'>
        <Seg<RecoverySizing>
            label='Recovery sizing'
            value={s.recoverySizing}
            onChange={v => set({ recoverySizing: v })}
            options={[
                ['PAYOUT', 'Payout-sized'],
                ['MULTIPLIER', 'Multiplier'],
            ]}
        />
        <div className='sf-grid2 sn-nums'>
            {s.recoverySizing === 'PAYOUT' ? (
                <Num label='Win back (%)' value={s.recoverShare} onCommit={n => set({ recoverShare: n })} hint='of what is owed' />
            ) : (
                <Num label='Multiplier' value={s.multiplier} onCommit={n => set({ multiplier: n })} />
            )}
            <Num label='Max steps' value={s.maxSteps} onCommit={n => set({ maxSteps: n })} hint='0 = no limit' />
            <Num label='Streak budget (× stake)' value={s.streakBudget} onCommit={n => set({ streakBudget: n })} hint='0 = off' />
            <Num label='Max stake' value={s.maxStake} onCommit={n => set({ maxStake: n })} hint='0 = no cap' />
        </div>
    </div>
);

/** Everything under the Virtual hook switch. */
export const VirtualHookFields = ({ s, set }: Props) => (
    <div className='sn-sub'>
        <Seg<VhMode>
            label='Virtual hook mode'
            value={s.vhMode}
            onChange={v => set({ vhMode: v })}
            options={[
                ['STREAK', 'Until paper wins'],
                ['FIXED', 'Fixed paper trades'],
            ]}
        />
        <div className='sf-grid2 sn-nums'>
            <Num label='Go virtual after losses' value={s.vhEnterLosses} onCommit={n => set({ vhEnterLosses: n })} hint='real losses in a row' />
            {s.vhMode === 'STREAK' ? (
                <Num label='Back to real after wins' value={s.vhReturnWins} onCommit={n => set({ vhReturnWins: n })} hint='paper wins in a row' />
            ) : (
                <Num label='Paper trades' value={s.vhFixedCount} onCommit={n => set({ vhFixedCount: n })} hint='then back to real' />
            )}
        </div>
    </div>
);

const SignalConditions = ({ s, set, streakAlwaysOn = false }: ConditionProps) => {
    const [open, setOpen] = useState(false);
    return (
        <div className='sn-conditions'>
            <button type='button' className='sn-more' aria-expanded={open} onClick={() => setOpen(v => !v)}>
                Signal conditions <span aria-hidden='true'>{open ? '−' : '+'}</span>
            </button>
            {open && (
                <div className='sn-morebody'>
                    <div className='sn-label'>Entry gates</div>
                    {streakAlwaysOn ? (
                        <div className='sn-label'>Win-streak guard (always on)</div>
                    ) : (
                        <Switch on={s.winStreakGate} onChange={v => set({ winStreakGate: v })} title='Win-streak guard' sub='' />
                    )}
                    {(streakAlwaysOn || s.winStreakGate) && (
                        <div className='sf-grid2 sn-nums'>
                            <Num label='Wins in a row' value={s.winStreak} onCommit={n => set({ winStreak: n })} hint='2–10' />
                            <Num label='Drop market at +losses' value={s.lossAbort} onCommit={n => set({ lossAbort: n })} hint='0–4' />
                        </div>
                    )}
                    <Switch on={s.pressureGate} onChange={v => set({ pressureGate: v })} title='Losing-digit pressure gate' sub='' />
                    {s.pressureGate && (
                        <div className='sn-nums'>
                            <Num label='Max pressure' value={s.pressureMax} onCommit={n => set({ pressureMax: n })} hint='10–90, lower is stricter' />
                        </div>
                    )}
                    <Switch on={s.multiWindowGate} onChange={v => set({ multiWindowGate: v })} title='Multi-window gate' sub='' />
                    <Switch on={s.winPressureGate} onChange={v => set({ winPressureGate: v })} title='Winning-digit pressure gate' sub='' />
                    {s.winPressureGate && (
                        <div className='sn-nums'>
                            <Num label='Min gain (pp)' value={s.winPressureMin} onCommit={n => set({ winPressureMin: n })} hint='1–15' />
                        </div>
                    )}
                    <Switch on={s.meterGuide} onChange={v => set({ meterGuide: v })} title='Meter guide' sub='' />
                    {s.meterGuide && (
                        <div className='sf-grid3 sn-nums'>
                            <Num label='Meter floor' value={s.meterFloor} onCommit={n => set({ meterFloor: n })} hint='0 = off' />
                            <Num label='Recovery floor' value={s.meterFloorRecovery} onCommit={n => set({ meterFloorRecovery: n })} hint='0 = off' />
                            <Num label='Patience (s)' value={s.meterPatience} onCommit={n => set({ meterPatience: n })} />
                        </div>
                    )}
                    <Switch on={s.pickyAfterLoss} onChange={v => set({ pickyAfterLoss: v })} title='Pickier after a loss' sub='' />

                    <div className='sn-label'>Recovery</div>
                    <Seg<RecoveryEntry>
                        label='Recovery entry'
                        value={s.recoveryEntry}
                        onChange={v => set({ recoveryEntry: v })}
                        options={[
                            ['OFF', 'Same'],
                            ['MOMENTUM', 'After wins'],
                            ['REVERSION', 'After losses'],
                            ['BOUNCE', 'Loss → win'],
                            ['BRAIN', 'Brain'],
                        ]}
                    />
                    {s.recoveryEntry !== 'OFF' && s.recoveryEntry !== 'BRAIN' && (
                        <div className='sn-nums'>
                            <Num label='Ticks in a row' value={s.recoveryForm} onCommit={n => set({ recoveryForm: n })} hint='2–8' />
                        </div>
                    )}

                    <div className='sn-label'>Loss shield</div>
                    <Switch on={s.lossShield} onChange={v => set({ lossShield: v })} title='Loss shield' sub='' />
                    {s.lossShield && (
                        <div className='sn-nums'>
                            <Num label='Rest for (trades)' value={s.restTrades} onCommit={n => set({ restTrades: n })} hint='doubles after 2 losses there' />
                        </div>
                    )}
                    <Switch on={s.vhOpening} onChange={v => set({ vhOpening: v })} title='Open every run on paper' sub='' />
                </div>
            )}
        </div>
    );
};

export default SignalConditions;
