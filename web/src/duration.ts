export const Duration = {
    units: [
        { label: "unitSecond", seconds: 1 },
        { label: "unitMinute", seconds: 60 },
        { label: "unitHour", seconds: 3600 },
        { label: "unitDay", seconds: 86400 },
    ] as const,
    unitFor(seconds: number): number {
        return this.units.findLast((unit) => seconds >= unit.seconds)?.seconds ?? 1;
    },
    seconds(value: number, unit: number): number {
        return Math.round(value * unit);
    },
    defaultJitter(delay: number): number {
        return Math.min(Math.round(delay / 10), 300);
    },
};
