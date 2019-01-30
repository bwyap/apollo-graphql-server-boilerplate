import { SubscriptionResolvers } from '../../types';
import { UserSubscriptions } from './User/UserSubscriptions';

// Subscription.Type is generated by `graphqlgen`.
export const Subscription: SubscriptionResolvers.Type = {
  ...SubscriptionResolvers.defaultResolvers,
  ...UserSubscriptions,
};
