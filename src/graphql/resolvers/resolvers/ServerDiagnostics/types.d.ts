import { QueryResolvers } from '../../../types';

/**
 * These interfaces are a subset of the types generated by `graphqlgen`.
 * Extend the resolvers required for the ServerDiagnostics model by usin
 * Typescript's `Pick` interface to select the methods that should be extended.
 */

export interface IServerDiagnosticsQueries
  extends Pick<QueryResolvers.Type, 'serverDiagnostics'> {}