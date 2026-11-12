// Approval workflow: who must approve a submitted week, step by step.
//
// A company picks an ordered list of steps (Settings -> approval steps):
//   supervisor       the employee's supervisor
//   project_manager  the PM of any project on the sheet (any one of them may decide)
//   gm               any active GM
// If a step has nobody to decide (e.g. no supervisor set, or the submitter is
// the only candidate) it falls back to the company admins; if there is still
// nobody, the step is skipped so a sheet can never get stuck.

function activeMembers(members) {
    return members.filter(m => m.status !== 'disabled');
}

function resolveStepApprovers(stepType, ctx) {
    const { submitterUid, members, projects, projectIds } = ctx;
    const active = activeMembers(members);
    const byUid = new Map(active.map(m => [m.uid, m]));
    let uids = [];
    if (stepType === 'supervisor') {
        const me = byUid.get(submitterUid) || members.find(m => m.uid === submitterUid);
        if (me && me.supervisorUid && byUid.has(me.supervisorUid)) uids = [me.supervisorUid];
    } else if (stepType === 'project_manager') {
        for (const pid of projectIds || []) {
            const p = projects.get(pid);
            if (p && p.pmUid && byUid.has(p.pmUid)) uids.push(p.pmUid);
        }
    } else if (stepType === 'gm') {
        uids = active.filter(m => m.role === 'gm').map(m => m.uid);
    }
    uids = [...new Set(uids)].filter(u => u !== submitterUid);
    if (!uids.length) {
        uids = active.filter(m => m.role === 'company_admin' && m.uid !== submitterUid).map(m => m.uid);
    }
    return uids.sort();
}

// First step at or after `from` that has approvers. null = nothing left (approved).
function nextStep(steps, from, ctx) {
    for (let i = from; i < (steps || []).length; i++) {
        const approvers = resolveStepApprovers(steps[i], ctx);
        if (approvers.length) return { stepIndex: i, stepType: steps[i], approvers };
    }
    return null;
}

module.exports = { resolveStepApprovers, nextStep };
