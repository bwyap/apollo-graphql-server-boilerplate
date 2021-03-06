import { CostMap } from './types';
import { Cost } from './enums';

// Define the cost of fields in your schema.
const costMap: CostMap = {
  Query: {
    user: {
      complexity: Cost.Standard,
    },
    users: {
      complexity: Cost.Standard,
    },
    expensiveUsers: {
      // Simulate an expensive query
      complexity: Cost.Expensive,
    },
    serverDiagnostics: {
      complexity: Cost.Static,
    },
  },
  Mutation: {
    addUser: {
      complexity: Cost.Standard,
    },
    deleteUser: {
      complexity: Cost.Standard,
    },
  },
  Subscription: {
    newUser: {
      complexity: Cost.Standard,
    },
  },
  User: {
    friends: {
      // Having to resolve an array of friends adds complexity
      complexity: Cost.Standard,
    },
  },
};

export default costMap;
