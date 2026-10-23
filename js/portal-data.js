(function () {
  const STORAGE_KEY = 'launchpoint-portal-preview-v1';

  const seed = {
    clients: [
      {
        id: 'northline', business: 'Northline Wellness', contact: 'Maya Robinson', email: 'maya@example.com',
        project: 'Website & booking flow', status: 'active', progress: 52, nextStep: 'Review homepage direction',
        nextCopy: 'We prepared the first visual direction. Review the layout and leave one clear round of feedback.',
        lastContact: '9:42 AM', unread: 2, targetDate: 'Nov 14', value: '$6,800',
        summary: 'Your new website and booking flow are taking shape. Everything you need to review is collected here.',
        milestones: [
          { label: 'Strategy & content', state: 'complete' },
          { label: 'Visual direction', state: 'current' },
          { label: 'Build & integrations', state: 'upcoming' },
          { label: 'Launch', state: 'upcoming' }
        ],
        messages: [
          { id: 'm1', sender: 'admin', name: 'Jacob', body: 'Hi Maya — the first homepage direction is ready. I focused the story around easier booking and a calmer first impression.', createdAt: '2026-10-22T15:08:00.000Z' },
          { id: 'm2', sender: 'client', name: 'Maya', body: 'This feels much closer to us. Can we make the membership option a little more visible?', createdAt: '2026-10-23T13:42:00.000Z' },
          { id: 'm3', sender: 'client', name: 'Maya', body: 'I also uploaded the new practitioner photos to the Drive folder.', createdAt: '2026-10-23T13:44:00.000Z' }
        ]
      },
      {
        id: 'cedar-stone', business: 'Cedar & Stone', contact: 'Andre Collins', email: 'andre@example.com',
        project: 'Local growth campaign', status: 'active', progress: 68, nextStep: 'Approve November ad set',
        nextCopy: 'Review the new campaign messages before we schedule the November launch.',
        lastContact: 'Yesterday', unread: 1, targetDate: 'Nov 3', value: '$2,400/mo',
        summary: 'Your campaign is active. New creative and the next local offer are ready for review.',
        milestones: [
          { label: 'Offer & audience', state: 'complete' }, { label: 'Campaign build', state: 'complete' },
          { label: 'Creative review', state: 'current' }, { label: 'Launch & optimize', state: 'upcoming' }
        ],
        messages: [
          { id: 'm4', sender: 'admin', name: 'Jacob', body: 'The November ad set is ready. The new version leads with the seasonal maintenance offer.', createdAt: '2026-10-22T18:20:00.000Z' },
          { id: 'm5', sender: 'client', name: 'Andre', body: 'Looks good. Is the service-area map updated too?', createdAt: '2026-10-22T19:03:00.000Z' }
        ]
      },
      {
        id: 'brightside', business: 'Brightside Dental', contact: 'Dr. Nia Harper', email: 'nia@example.com',
        project: 'Website refresh', status: 'waiting', progress: 88, nextStep: 'Schedule final handoff',
        nextCopy: 'Choose a handoff time and we will walk through editing, analytics, and launch support.',
        lastContact: 'Oct 21', unread: 0, targetDate: 'Oct 30', value: '$4,950',
        summary: 'The website is ready for final handoff. Your analytics and editing guide are prepared.',
        milestones: [
          { label: 'Content & structure', state: 'complete' }, { label: 'Design & build', state: 'complete' },
          { label: 'Quality review', state: 'complete' }, { label: 'Handoff', state: 'current' }
        ],
        messages: [
          { id: 'm6', sender: 'admin', name: 'Jacob', body: 'Everything passed the final review. Send me two handoff times that work for your team.', createdAt: '2026-10-21T16:10:00.000Z' }
        ]
      },
      {
        id: 'juniper', business: 'Juniper House', contact: 'Leah Bennett', email: 'leah@example.com',
        project: 'Brand & social launch', status: 'complete', progress: 100, nextStep: 'Monthly performance review',
        nextCopy: 'Your launch is complete. We will review the first month of performance and plan the next content cycle.',
        lastContact: 'Oct 18', unread: 0, targetDate: 'Live', value: '$1,200/mo',
        summary: 'Your brand and social launch are live. This portal now holds monthly reports and next steps.',
        milestones: [
          { label: 'Brand direction', state: 'complete' }, { label: 'Content system', state: 'complete' },
          { label: 'Launch', state: 'complete' }, { label: 'Monthly review', state: 'current' }
        ],
        messages: [
          { id: 'm7', sender: 'client', name: 'Leah', body: 'The launch looked great. Thank you for keeping the rollout so organized.', createdAt: '2026-10-18T14:16:00.000Z' },
          { id: 'm8', sender: 'admin', name: 'Jacob', body: 'Glad to hear it. I will add the first performance snapshot here next month.', createdAt: '2026-10-18T14:40:00.000Z' }
        ]
      }
    ]
  };

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const read = () => {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (value && Array.isArray(value.clients)) return value;
    } catch (_) {}
    const initial = clone(seed);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
    return initial;
  };
  const write = (value) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    window.dispatchEvent(new CustomEvent('launchpoint:portal-update', { detail: clone(value) }));
  };

  window.LaunchPointPortal = {
    read,
    write,
    reset: () => write(clone(seed)),
    getClient(id) { return read().clients.find((client) => client.id === id) || read().clients[0]; },
    formatTime(value) {
      const date = new Date(value);
      return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
    },
    initials(value) { return value.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase(); }
  };
})();
