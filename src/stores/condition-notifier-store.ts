import { action, makeObservable, observable } from 'mobx';

type ConditionNotification = {
    condition: string;
    digits: string;
    market: string;
    result: boolean;
    source: string;
    timestamp: number;
};

class ConditionNotifierStore {
    condition: ConditionNotification | null = null;

    constructor() {
        makeObservable(this, {
            condition: observable,
            setCondition: action.bound,
        });
    }

    setCondition(condition: ConditionNotification) {
        this.condition = condition;
    }
}

export const conditionNotifierStore = new ConditionNotifierStore();
