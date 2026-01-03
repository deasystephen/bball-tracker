import { View, Text, StyleSheet } from 'react-native';

/**
 * Games screen - list of games and ability to track new games
 */
export default function Games() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Games</Text>
      <Text style={styles.placeholder}>Game tracking coming soon...</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    backgroundColor: '#fff',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 20,
  },
  placeholder: {
    fontSize: 16,
    color: '#666',
  },
});
