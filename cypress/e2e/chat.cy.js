describe('Anın Sohbeti', () => {
  it('Chat input is visible', () => {
    cy.visit('http://localhost:6000')
    cy.get('input[type="text"]').should('be.visible')
  })

  it('Gönder ve Sonraki butonları görünüyor', () => {
    cy.get('button').contains('Gönder').should('be.visible')
    cy.get('button').contains('Sonraki').should('be.visible')
  })
})

