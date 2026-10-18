/** Tendora's original service material, decomposed into responsibilities and ordinary statements. */
export const tendora = {
  name: 'Tendora service',
  role: 'Tendora',
  statements: ['Tendora is an online store.'],
  children: [
    {
      role: 'Sales',
      statements: ['Tendora sells services directly to customers over the internet.'],
    },
    {
      role: 'Customer service',
      statements: [
        'Customer service provides general assistance.',
        'Customer service uses customer tickets to handle issues.',
      ],
      children: [
        { role: 'Product advice', statements: ['Customer service answers product questions.'] },
        {
          role: 'Orders and returns',
          statements: [
            'Customer service manages customer orders.',
            'Customer service manages product returns.',
          ],
        },
        {
          role: 'Billing',
          statements: ['Customer service handles billing issues.'],
          children: [
            { role: 'Payments', statements: ['The billing team processes payments.'] },
            {
              role: 'Payout failures',
              statements: [
                'The billing team handles payout failures.',
                'If a ticket concerns a payout failure, customer service routes the ticket to the billing team.',
              ],
            },
          ],
        },
        {
          role: 'Accounts',
          statements: ['Customer service handles account issues.'],
          children: [
            {
              role: 'Login failures',
              statements: [
                'The account team handles login failures.',
                'If a ticket concerns a login failure, customer service routes the ticket to the account team.',
              ],
            },
            {
              role: 'Account access',
              statements: ['The account team handles account access problems.'],
            },
          ],
        },
        {
          role: 'Human assistance',
          statements: [
            'If a ticket concerns an urgent failure and customer service routes the ticket to a team, the team offers human assistance.',
            'If customer service routes a ticket to a team and the ticket concerns frequent failures, the team offers human assistance.',
          ],
        },
      ],
    },
  ],
};
export const tendoraQuestions = [
  'Who processes payments?',
  'Who handles payout failures?',
  'Who handles login failures?',
  'Who manages product returns?',
  'Does the account team process payments?',
  'Who offers human assistance?',
  'Through what channel does Tendora sell services?',
];
export const tendoraCases = [
  'A ticket concerns an urgent payout failure.',
  'A ticket concerns an urgent login failure.',
];
