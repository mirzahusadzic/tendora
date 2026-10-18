/** Language-only example. Roles organize sources; their names are not evidence. */
export const theatre = {
  name: 'Harbour theatre',
  role: 'Production',
  statements: [
    'The theatre prepares a public performance.',
    'The director coordinates the rehearsal.',
  ],
  children: [
    {
      role: 'Technical production',
      statements: [
        'The technical team maintains the stage.',
        'If the technician checks the lights, the technician approves the rehearsal.',
      ],
      children: [
        {
          role: 'Rigging',
          statements: [
            'The technician inspects the rig.',
            'The rig supports the lights.',
            'The rig does not support the curtain.',
          ],
        },
        {
          role: 'Lighting',
          statements: [
            'If the technician inspects the rig, the technician checks the lights.',
            'The lights illuminate the stage.',
            'The lighting designer adjusts the colours.',
          ],
        },
        {
          role: 'Sound',
          statements: [
            'The sound engineer tests the microphones.',
            'The microphones amplify the performers.',
          ],
        },
      ],
    },
    {
      role: 'Workshop',
      statements: ['Sam repairs bicycles.', 'The bicycles are stage props.'],
      children: [
        {
          role: 'Costumes',
          statements: [
            'The costume designer repairs the costumes.',
            'The wardrobe assistant stores the costumes.',
          ],
        },
      ],
    },
    {
      role: 'Front of house',
      statements: [
        'Nora checks the tickets.',
        'The ushers guide the audience.',
        'The audience enters the hall.',
      ],
    },
  ],
};

export const theatreQuestions = [
  'Who approves the rehearsal?',
  'Who inspects the rig?',
  'Does the rig support the curtain?',
  'Who approves the curtain?',
  'Who repairs bikes?',
  'Does Sam repair bikes?',
  'Does Sam repair bicycles?',
  'Who stores the costumes?',
];
