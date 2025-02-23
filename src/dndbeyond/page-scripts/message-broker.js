const messageBroker = new DDBMessageBroker();
messageBroker.register();

function sendRollToGameLog(request) {
	const message = {
        persist: false,
    };
    if (request.action === "roll") {
        message.eventType = "custom/beyond20/request";
        message.data = {
            'request': request
        }
    } else if (request.action === "rendered-roll") {
        message.eventType = "custom/beyond20/roll";
        message.data = {
            'request': request.request,
            'render': request.html
        }
	} else {
        // Unknown action type
        return;
    }
	messageBroker.postMessage(message);
}

function rollToDDBRoll(roll, forceResults=false) {
    let constant = 0;
    let lastOperation = '+';
    const sets = [];
    const results = [];
    for (const part of roll.parts) {
        if (['-', '+'].includes(part)) {
            lastOperation = part;
        } else if (typeof(part) === "number") {
            constant = constant + part * (lastOperation === "+" ? 1 : -1);
        } else if (part.formula) {
            let operation = 0; // sum
            if (part.modifiers.includes("kl") || part.modifiers.includes("dh"))
                operation = 1; // min
            else if (part.modifiers.includes("kh") || part.modifiers.includes("dl"))
                operation = 2; // max
            // the game log will crash if a message is posted with a dieType that isn't supported
            const dieType = [4, 6, 8, 10, 12, 20, 100].includes(part.faces) ? `d${part.faces}` : 'd100';
            sets.push({
                count: part.amount,
                dieType,
                operation,
                dice: part.rolls.filter(r => !r.discarded).map(r => ({dieType, dieValue: r.roll || 0}))
            });
            if (part.total !== undefined) {
                results.push(part.total);
            }
        }
    }
    const rollToKind = {
        "critical-damage": "critical hit"
    }
    const rollToType = {
        "to-hit": "to hit",
        "damage": "damage",
        "critical-damage": "damage",
        "skill-check": "check",
        "ability-check": "check",
        "initiative": "check",
        "saving-throw": "save",
        "death-save": "save",

    }

    const data = {
        diceNotation: {
            constant,
            set: sets
        },
        diceNotationStr: roll.formula,
        rollKind: rollToKind[roll.type] || "",
        rollType: rollToType[roll.type] || "roll"
    }
    // diceOperation options: 0 = sum, 1 = min, 2 = max
    // rollKind options : "" = none, advantage, disadvantage, critical hit
    // rollType options : roll, to hit, damage, heal, spell, save, check
    if (forceResults || results.length > 0) {
        data.result = {
            constant,
            text: roll.parts.map(p => p.total === undefined ? String(p) : String(p.total)).join(""),
            total: roll.total,
            values: results
        };
    }
    return data;
}

let lastMessage = null;
function pendingRoll(rollData) {
    //console.log("rolling ", rollData);
    messageBroker.on("dice/roll/pending", (message) => {
        lastMessage = message;
        messageBroker.postMessage({
            persist: false,
            eventType: "dice/roll/pending",
            entityType: message.entityType,
            entityId: message.entityId,
            gameId: message.gameId,
            messageScope: message.messageScope,
            messageTarget: message.messageTarget,
            userId: message.userId,
            data: {
                action: rollData.name,
                context: message.data.context,
                rollId: message.data.rollId,
                rolls: rollData.rolls.map(r => rollToDDBRoll(r)),
                setId: message.data.setId
            }
        });
        // Stop propagation
        return false;
    }, {once: true, send: true, recv: false});
    messageBroker.blockMessages({type: "dice/roll/fulfilled", once: true});
}
function fulfilledRoll(rollData) {
    //console.log("fulfilled roll ", rollData);
    lastMessage = lastMessage || {data: {}};
    const extraData = lastMessage ? {
        context: lastMessage.data.context,
        rollId: lastMessage.data.rollId,
        setId: lastMessage.data.setId || "8201337"
    } : {
        setId: "8201337" // Not setting it makes it use "Basic Black" by default. Using an invalid value is better
    }
    // For initiative to work in the Encounter builder, it needs to have the action name "Initiative" and not "Initiative(+x)" that B20 sends
    const action = /^Initiative/.test(rollData.name) ? "Initiative" : rollData.name;
    messageBroker.postMessage({
        persist: true,
        eventType: "dice/roll/fulfilled",
        entityType: lastMessage.entityType,
        entityId: lastMessage.entityId,
        gameId: lastMessage.gameId,
        messageScope: lastMessage.messageScope,
        messageTarget: lastMessage.messageTarget,
        userId: lastMessage.userId,
        data: {
            action,
            rolls: rollData.rolls.map(r => rollToDDBRoll(r, true)),
            ...extraData
        }
    });
    // Avoid overwriting the old roll in case a roll generates multiple fulfilled rolls (critical hit)
    lastMessage.data.rollId = messageBroker.uuid();
}

function disconnectAllEvents() {
    for (let event of registered_events)
        document.removeEventListener(...event);
    messageBroker.unregister();
}

var registered_events = [];
registered_events.push(addCustomEventListener("rendered-roll", sendRollToGameLog));
registered_events.push(addCustomEventListener("roll", sendRollToGameLog));
registered_events.push(addCustomEventListener("MBPendingRoll", pendingRoll));
registered_events.push(addCustomEventListener("MBFulfilledRoll", fulfilledRoll));
registered_events.push(addCustomEventListener("disconnect", disconnectAllEvents));